#!/usr/bin/env node

import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

import { parseArgs, splitRawArgumentString } from "./lib/args.mjs";
import {
    buildPersistentTaskThreadName,
    DEFAULT_CONTINUE_PROMPT,
    findLatestTaskThread,
    getCodexAuthStatus,
    getCodexAvailability,
    getSessionRuntimeStatus,
    interruptAppServerTurn,
    parseStructuredOutput,
    readOutputSchema,
    runAppServerReview,
    runAppServerTurn
  } from "./lib/codex.mjs";
import { readStdinIfPiped } from "./lib/fs.mjs";
import { collectReviewContext, ensureGitRepository, resolveReviewTarget } from "./lib/git.mjs";
import { binaryAvailable, terminateProcessTree } from "./lib/process.mjs";
import { loadPromptTemplate, interpolateTemplate } from "./lib/prompts.mjs";
import {
  clearConfig,
  generateJobId,
  getConfig,
  listJobs,
  setConfig,
  upsertJob,
  writeJobFile
} from "./lib/state.mjs";
import {
  buildSingleJobSnapshot,
  buildStatusSnapshot,
  readStoredJob,
  resolveCancelableJob,
  resolveResultJob,
  sortJobsNewestFirst
} from "./lib/job-control.mjs";
import {
  appendLogLine,
  createJobLogFile,
  createJobProgressUpdater,
  createJobRecord,
  createProgressReporter,
  nowIso,
  runTrackedJob,
  SESSION_ID_ENV
} from "./lib/tracked-jobs.mjs";
import { resolveWorkspaceRoot } from "./lib/workspace.mjs";
import { withResilience } from "./lib/resilience.mjs";
import {
  renderNativeReviewResult,
  renderReviewResult,
  renderStoredJobResult,
  renderCancelReport,
  renderJobStatusReport,
  renderSetupReport,
  renderStatusReport,
  renderTaskResult
} from "./lib/render.mjs";

const ROOT_DIR = path.resolve(fileURLToPath(new URL("..", import.meta.url)));
const REVIEW_SCHEMA = path.join(ROOT_DIR, "schemas", "review-output.schema.json");
const DEFAULT_STATUS_WAIT_TIMEOUT_MS = 240000;
const DEFAULT_STATUS_POLL_INTERVAL_MS = 2000;
const VALID_REASONING_EFFORTS = new Set(["none", "minimal", "low", "medium", "high", "xhigh"]);
const MODEL_ALIASES = new Map([["spark", "gpt-5.3-codex-spark"]]);
const STOP_REVIEW_TASK_MARKER = "Run a stop-gate review of the previous Claude turn.";
const LEDGER_PHASES = ["P1", "P2", "P3", "P4", "P5", "P6", "P7", "P8"];

function printUsage() {
  console.log(
    [
      "Usage:",
      "  node scripts/codex-companion.mjs setup [--enable-review-gate|--disable-review-gate] [--json]",
      "  node scripts/codex-companion.mjs review [--wait|--background] [--base <ref>] [--scope <auto|working-tree|branch>]",
      "  node scripts/codex-companion.mjs adversarial-review [--wait|--background] [--base <ref>] [--scope <auto|working-tree|branch>] [focus text]",
      "  node scripts/codex-companion.mjs task [--background] [--write] [--resume-last|--resume|--fresh] [--model <model|spark>] [--effort <none|minimal|low|medium|high|xhigh>] [prompt]",
      "  node scripts/codex-companion.mjs status [job-id] [--all] [--json]",
      "  node scripts/codex-companion.mjs result [job-id] [--json]",
      "  node scripts/codex-companion.mjs cancel [job-id] [--json]",
      "  node scripts/codex-companion.mjs ledger append <flow-id> <phase> <owner> [extra-json] [--json]",
      "  node scripts/codex-companion.mjs ledger read [--flow <id>] [--last N] [--json]",
      "  node scripts/codex-companion.mjs ledger summary [--last N] [--json]",
      "  node scripts/codex-companion.mjs ledger diagnose [--last N] [--json]",
      "  node scripts/codex-companion.mjs ledger budget [--last N] [--since-hours H] [--json]",
      "  node scripts/codex-companion.mjs ledger escalate <flow-id> <reason...> [--to human|lead] [--from <teammate>] [--artifact-ref <ptr>] [--json]",
      "  node scripts/codex-companion.mjs ledger resolve <flow-id> <escalation-id> <decision...> [--by <resolver>] [--json]",
      "  node scripts/codex-companion.mjs worktree ensure <flow-id> <phase> [--repo-path <dir>] [--json]",
      "  node scripts/codex-companion.mjs worktree cleanup <flow-id> [--repo-path <dir>] [--json]",
      "  node scripts/codex-companion.mjs thread list [--json]",
      "  node scripts/codex-companion.mjs config get [<key>] [--json]",
      "  node scripts/codex-companion.mjs config set <key> <value-json> [--json]",
      "  node scripts/codex-companion.mjs config reset <key> [--json]",
      "  node scripts/codex-companion.mjs config routing set <phase> <model> <effort> [--json]",
      "  node scripts/codex-companion.mjs config routing get [<phase>] [--json]",
      "  node scripts/codex-companion.mjs config routing reset [--json]",
      "  node scripts/codex-companion.mjs watch start [--throttle-ms N] [--model <m>] [--json]",
      "  node scripts/codex-companion.mjs watch stop [--json]",
      "  node scripts/codex-companion.mjs watch status [--json]",
      "  node scripts/codex-companion.mjs findings [--last N] [--json]"
    ].join("\n")
  );
}

function outputResult(value, asJson) {
  if (asJson) {
    console.log(JSON.stringify(value, null, 2));
  } else {
    process.stdout.write(value);
  }
}

function outputCommandResult(payload, rendered, asJson) {
  outputResult(asJson ? payload : rendered, asJson);
}

/**
 * Extract token-usage info from a Codex turn object, defensively.
 * The exact field names in the app-server's response are not
 * formally declared in the cached plugin's type stubs, so this
 * helper checks multiple common shapes and returns normalized
 * {input, output, total, reasoning, cached, raw} or null.
 */
function extractTokenUsage(turn) {
  if (!turn || typeof turn !== "object") return null;

  // Codex app-server emits tokens via a dedicated `thread/tokenUsage/updated`
  // event, shape { total: { totalTokens, inputTokens, outputTokens,
  // reasoningOutputTokens, cachedInputTokens }, last: { ... }, modelContextWindow }.
  // completeTurn() in lib/codex.mjs attaches this as `turn.tokenUsage`.
  // The `last` slice is per-turn; `total` is thread-cumulative. We prefer `last`
  // so ledger entries capture the tokens burned by THIS dispatch, not the
  // running thread total.
  const codexUsage = turn.tokenUsage?.last || turn.tokenUsage?.total || turn.tokenUsage;
  const readNumber = (val) => (typeof val === "number" && Number.isFinite(val) ? val : null);

  if (codexUsage && typeof codexUsage === "object" && (
    codexUsage.totalTokens != null ||
    codexUsage.inputTokens != null ||
    codexUsage.outputTokens != null
  )) {
    const input = readNumber(codexUsage.inputTokens);
    const output = readNumber(codexUsage.outputTokens);
    const totalDirect = readNumber(codexUsage.totalTokens);
    const total = totalDirect ?? (typeof input === "number" && typeof output === "number" ? input + output : null);
    const reasoning = readNumber(codexUsage.reasoningOutputTokens);
    const cached = readNumber(codexUsage.cachedInputTokens);
    return { input, output, total, reasoning, cached, raw: codexUsage };
  }

  // Legacy / Anthropic-style shapes retained for back-compat with older Codex
  // app-server builds and for any non-Codex callers that may pass a turn-like
  // object. Order matters — we try Codex-snake_case first for symmetry, then
  // fall through to the generic `usage` / `metrics` locations.
  const candidates = [
    turn.usage,
    turn.token_usage,
    turn.metrics?.usage,
    turn.metrics?.tokens
  ].filter((v) => v && typeof v === "object");
  if (candidates.length === 0) return null;
  const u = candidates[0];
  const input = readNumber(u.input_tokens) ?? readNumber(u.prompt_tokens) ?? readNumber(u.input) ?? readNumber(u.inputTokens);
  const output = readNumber(u.output_tokens) ?? readNumber(u.completion_tokens) ?? readNumber(u.output) ?? readNumber(u.outputTokens);
  const totalDirect = readNumber(u.total_tokens) ?? readNumber(u.total) ?? readNumber(u.totalTokens);
  const total = totalDirect ?? (typeof input === "number" && typeof output === "number" ? input + output : null);
  const reasoning = readNumber(u.reasoning_tokens) ?? readNumber(u.reasoning) ?? readNumber(u.reasoningOutputTokens);
  const cached = readNumber(u.cached_input_tokens) ?? readNumber(u.cached) ?? readNumber(u.cachedInputTokens);
  return { input, output, total, reasoning, cached, raw: u };
}

function normalizeRequestedModel(model) {
  if (model == null) {
    return null;
  }
  const normalized = String(model).trim();
  if (!normalized) {
    return null;
  }
  return MODEL_ALIASES.get(normalized.toLowerCase()) ?? normalized;
}

function normalizeReasoningEffort(effort) {
  if (effort == null) {
    return null;
  }
  const normalized = String(effort).trim().toLowerCase();
  if (!normalized) {
    return null;
  }
  if (!VALID_REASONING_EFFORTS.has(normalized)) {
    throw new Error(
      `Unsupported reasoning effort "${effort}". Use one of: none, minimal, low, medium, high, xhigh.`
    );
  }
  return normalized;
}

function normalizeArgv(argv) {
  if (argv.length === 1) {
    const [raw] = argv;
    if (!raw || !raw.trim()) {
      return [];
    }
    return splitRawArgumentString(raw);
  }
  return argv;
}

function parseCommandInput(argv, config = {}) {
  return parseArgs(normalizeArgv(argv), {
    ...config,
    aliasMap: {
      C: "cwd",
      ...(config.aliasMap ?? {})
    }
  });
}

function resolveCommandCwd(options = {}) {
  return options.cwd ? path.resolve(process.cwd(), options.cwd) : process.cwd();
}

function resolveCommandWorkspace(options = {}) {
  return resolveWorkspaceRoot(resolveCommandCwd(options));
}

// Resolve the cowork state directory.
//
// Precedence (highest wins):
//   1. COWORK_STATE_DIR env var (absolute path). Lets multiple worktrees/sessions
//      keep disjoint ledgers without cross-contamination.
//   2. `<workspaceRoot>/.cowork` — the historical default.
//
// A leading `~/` in COWORK_STATE_DIR is expanded to the user's home dir so callers
// can drop e.g. `~/.cowork-alt` into a shell profile without fighting shell expansion.
function resolveCoworkPaths(workspaceRoot) {
  const envOverride = process.env.COWORK_STATE_DIR;
  let coworkDir;
  if (envOverride && envOverride.trim()) {
    const raw = envOverride.trim();
    coworkDir = raw.startsWith("~/")
      ? path.join(os.homedir(), raw.slice(2))
      : path.resolve(raw);
  } else {
    coworkDir = path.join(workspaceRoot, ".cowork");
  }
  return {
    coworkDir,
    sessionsDir: path.join(coworkDir, "sessions"),
    ledgerFile: path.join(coworkDir, "ledger.jsonl")
  };
}

function ensureLedgerStorage(workspaceRoot) {
  const paths = resolveCoworkPaths(workspaceRoot);
  fs.mkdirSync(paths.sessionsDir, { recursive: true });
  if (!fs.existsSync(paths.ledgerFile)) {
    fs.writeFileSync(paths.ledgerFile, "", "utf8");
  }
  return paths;
}

function parseOptionalExtraJson(raw) {
  if (raw == null || raw.trim() === "") {
    return {};
  }

  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error("Invalid extra-json payload. Provide a valid JSON object string.");
  }

  if (parsed == null || Array.isArray(parsed) || typeof parsed !== "object") {
    throw new Error("Invalid extra-json payload. Expected a JSON object.");
  }
  return parsed;
}

function parsePositiveInteger(value, flagName) {
  const parsed = Number.parseInt(String(value ?? ""), 10);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new Error(`Invalid ${flagName} value "${value}". Use a positive integer.`);
  }
  return parsed;
}

function entryTimestampValue(entry) {
  const parsed = Date.parse(String(entry?.timestamp ?? ""));
  return Number.isNaN(parsed) ? 0 : parsed;
}

function sortLedgerEntriesAscending(entries) {
  return [...entries].sort((left, right) => {
    const delta = entryTimestampValue(left) - entryTimestampValue(right);
    if (delta !== 0) {
      return delta;
    }
    return String(left.flow_id ?? "").localeCompare(String(right.flow_id ?? ""));
  });
}

function normalizeLedgerEntry(entry) {
  if (!entry || typeof entry !== "object") {
    return null;
  }

  // schema_version: preserve if present; default to 1 for pre-5.2 entries so
  // readers can special-case newer schemas without breaking older ledgers.
  const rawSchemaVersion = entry.schema_version;
  const schemaVersion =
    typeof rawSchemaVersion === "number" && Number.isFinite(rawSchemaVersion) && rawSchemaVersion > 0
      ? rawSchemaVersion
      : 1;

  const normalized = {
    schema_version: schemaVersion,
    timestamp: Object.prototype.hasOwnProperty.call(entry, "timestamp") ? entry.timestamp ?? null : null,
    flow_id:
      typeof entry.flow_id === "string" && entry.flow_id.trim()
        ? entry.flow_id
        : typeof entry.flowId === "string" && entry.flowId.trim()
          ? entry.flowId
          : null,
    phase:
      typeof entry.phase === "string" && entry.phase.trim()
        ? entry.phase
        : null,
    owner:
      typeof entry.owner === "string" && entry.owner.trim()
        ? entry.owner
        : null,
    effort: entry.effort == null ? null : String(entry.effort),
    background: Boolean(entry.background),
    resumed: Boolean(entry.resumed)
  };

  if (Object.prototype.hasOwnProperty.call(entry, "fallback_triggered")) {
    normalized.fallback_triggered = Boolean(entry.fallback_triggered);
  }

  if (Object.prototype.hasOwnProperty.call(entry, "extra")) {
    normalized.extra = entry.extra;
  }

  if (!normalized.flow_id || !normalized.phase || !normalized.owner) {
    return null;
  }

  return normalized;
}

function readLedgerEntries(ledgerFile) {
  if (!fs.existsSync(ledgerFile)) {
    return [];
  }

  const content = fs.readFileSync(ledgerFile, "utf8");
  if (!content.trim()) {
    return [];
  }

  const entries = [];
  for (const line of content.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed) {
      continue;
    }

    try {
      const parsed = JSON.parse(trimmed);
      const normalized = normalizeLedgerEntry(parsed);
      if (normalized) {
        entries.push(normalized);
      }
    } catch {
      // Ignore malformed lines to preserve append-only ledger behavior.
    }
  }

  return entries;
}

function selectLastFlowEntries(entries, flowCount) {
  const latestByFlow = new Map();
  for (const entry of entries) {
    if (!entry.flow_id) {
      continue;
    }
    const ts = entryTimestampValue(entry);
    const existing = latestByFlow.get(entry.flow_id);
    if (existing == null || ts > existing) {
      latestByFlow.set(entry.flow_id, ts);
    }
  }

  const selectedFlowIds = new Set(
    [...latestByFlow.entries()]
      .sort((left, right) => right[1] - left[1])
      .slice(0, flowCount)
      .map(([flowId]) => flowId)
  );

  return entries.filter((entry) => selectedFlowIds.has(entry.flow_id));
}

function summarizeLedgerFlows(entries) {
  const ordered = sortLedgerEntriesAscending(entries);
  const flows = new Map();

  for (const entry of ordered) {
    if (!flows.has(entry.flow_id)) {
      flows.set(entry.flow_id, {
        flow_id: entry.flow_id,
        phase_owners_multi: {},
        entries: [],
        fallback_count: 0,
        latest_timestamp: entry.timestamp
      });
    }

    const flow = flows.get(entry.flow_id);
    flow.entries.push(entry);
    if (!flow.phase_owners_multi[entry.phase]) {
      flow.phase_owners_multi[entry.phase] = [];
    }
    const owners = flow.phase_owners_multi[entry.phase];
    if (!owners.includes(entry.owner)) {
      owners.push(entry.owner);
    }
    flow.latest_timestamp =
      entryTimestampValue(entry) >= entryTimestampValue({ timestamp: flow.latest_timestamp })
        ? entry.timestamp
        : flow.latest_timestamp;

    if (entry.fallback_triggered) {
      flow.fallback_count += 1;
    }
  }

  const summaries = [];
  for (const flow of flows.values()) {
    const codexEntries = flow.entries.filter((entry) => String(entry.owner).toLowerCase() === "codex").length;
    const codexComputeShare = flow.entries.length > 0 ? codexEntries / flow.entries.length : 0;

    const p4Owners = (flow.phase_owners_multi.P4 ?? []).map((o) => String(o).toLowerCase());
    const p6Owners = (flow.phase_owners_multi.P6 ?? []).map((o) => String(o).toLowerCase());
    const p5Entries = flow.entries.filter((entry) => entry.phase === "P5");
    const p5Entry = p5Entries.length ? p5Entries[p5Entries.length - 1] : null;
    const p5Extra = p5Entry?.extra && typeof p5Entry.extra === "object" ? p5Entry.extra : {};
    const revisionCountRaw = p5Extra.ratify_revision_count ?? p5Extra.revision_count ?? 0;
    const revisionCount = Number.isFinite(Number(revisionCountRaw)) ? Number(revisionCountRaw) : 0;
    const fullRewrite = Boolean(p5Extra.full_rewrite);
    const ratifyWithinCap = revisionCount <= 1 && !fullRewrite;

    const phaseOwners = Object.fromEntries(
      LEDGER_PHASES.map((phase) => {
        const owners = flow.phase_owners_multi[phase] ?? [];
        if (owners.length === 0) return [phase, null];
        if (owners.length === 1) return [phase, owners[0]];
        return [phase, owners.join("+")];
      })
    );

    summaries.push({
      flow_id: flow.flow_id,
      latest_timestamp: flow.latest_timestamp,
      phase_owners: phaseOwners,
      phase_owners_multi: flow.phase_owners_multi,
      entry_count: flow.entries.length,
      codex_entry_count: codexEntries,
      codex_compute_share: Number(codexComputeShare.toFixed(4)),
      fallback_trigger_count: flow.fallback_count,
      ratify_revision_count: revisionCount,
      ratify_full_rewrite: fullRewrite,
      success_criteria_met: p4Owners.includes("codex") && p6Owners.includes("codex") && ratifyWithinCap
    });
  }

  return summaries.sort((left, right) => {
    const delta = entryTimestampValue({ timestamp: right.latest_timestamp }) - entryTimestampValue({ timestamp: left.latest_timestamp });
    if (delta !== 0) {
      return delta;
    }
    return String(left.flow_id).localeCompare(String(right.flow_id));
  });
}

// Current schema version for ledger entries. Bump when the event shape changes
// in a way that readers must handle (new mandatory field, renamed field, etc.).
// Entries without `schema_version` are treated as v1 for back-compat.
const LEDGER_SCHEMA_VERSION = 1;

// Atomic-append safety ceiling. On POSIX, writes of ≤ PIPE_BUF (4096) bytes via
// O_APPEND are guaranteed atomic — `fs.appendFileSync` uses O_APPEND internally,
// so entries under this ceiling cannot interleave under parallel writers. On
// Windows, single-syscall appends via `fs.appendFileSync` are atomic in practice
// for the same sizes. Above the ceiling, atomicity is not guaranteed on POSIX,
// so we fail loud rather than corrupt the ledger silently.
const LEDGER_LINE_BYTE_CEILING = 4000;

function buildLedgerEntry({ flowId, phase, owner, extra }) {
  const extras = { ...extra };
  const effort = extras.effort == null ? null : String(extras.effort);
  const background = Boolean(extras.background);
  const resumed = Boolean(extras.resumed);
  const fallbackTriggered = Object.prototype.hasOwnProperty.call(extras, "fallback_triggered")
    ? Boolean(extras.fallback_triggered)
    : undefined;

  delete extras.effort;
  delete extras.background;
  delete extras.resumed;
  delete extras.fallback_triggered;

  const entry = {
    schema_version: LEDGER_SCHEMA_VERSION,
    timestamp: nowIso(),
    flow_id: flowId,
    phase,
    owner,
    effort,
    background,
    resumed
  };

  if (fallbackTriggered !== undefined) {
    entry.fallback_triggered = fallbackTriggered;
  }

  if (Object.keys(extras).length > 0) {
    entry.extra = extras;
  }

  return entry;
}

// Single-syscall atomic append. Enforces `LEDGER_LINE_BYTE_CEILING` so we can
// rely on POSIX O_APPEND atomicity for parallel-teammate writes without a lock
// file. If an entry exceeds the ceiling (usually a bloated `extra`), callers
// should trim or summarize before appending — silently corrupting the ledger
// is worse than failing loudly.
function appendLedgerEntry(ledgerFile, entry) {
  const line = `${JSON.stringify(entry)}\n`;
  const bytes = Buffer.byteLength(line, "utf8");
  if (bytes > LEDGER_LINE_BYTE_CEILING) {
    throw new Error(
      `Ledger entry ${bytes}B exceeds atomicity ceiling ${LEDGER_LINE_BYTE_CEILING}B ` +
      `(flow=${entry.flow_id} phase=${entry.phase}). Trim the \`extra\` payload.`
    );
  }
  fs.appendFileSync(ledgerFile, line, "utf8");
}

function renderLedgerAppend(payload) {
  return `Appended ledger entry: ${payload.entry.flow_id} ${payload.entry.phase} (${payload.entry.owner}).\n`;
}

function renderLedgerRead(payload) {
  if (!payload.flows.length) {
    return "No ledger entries found for the requested scope.\n";
  }

  const lines = [
    `Ledger scope: ${payload.flow_count} flow(s), ${payload.entry_count} entr${payload.entry_count === 1 ? "y" : "ies"}.`
  ];

  for (const flow of payload.flows) {
    const p4Owner = flow.phase_owners.P4 ?? "n/a";
    const p6Owner = flow.phase_owners.P6 ?? "n/a";
    lines.push(
      `- ${flow.flow_id}: P4=${p4Owner}, P6=${p6Owner}, success=${flow.success_criteria_met ? "yes" : "no"}, fallbacks=${flow.fallback_trigger_count}`
    );
  }

  return `${lines.join("\n")}\n`;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function shorten(text, limit = 96) {
  const normalized = String(text ?? "").trim().replace(/\s+/g, " ");
  if (!normalized) {
    return "";
  }
  if (normalized.length <= limit) {
    return normalized;
  }
  return `${normalized.slice(0, limit - 3)}...`;
}

function firstMeaningfulLine(text, fallback) {
  const line = String(text ?? "")
    .split(/\r?\n/)
    .map((value) => value.trim())
    .find(Boolean);
  return line ?? fallback;
}

async function buildSetupReport(cwd, actionsTaken = []) {
  const workspaceRoot = resolveWorkspaceRoot(cwd);
  const nodeStatus = binaryAvailable("node", ["--version"], { cwd });
  const npmStatus = binaryAvailable("npm", ["--version"], { cwd });
  const codexStatus = getCodexAvailability(cwd);
  const authStatus = await getCodexAuthStatus(cwd);
  const config = getConfig(workspaceRoot);

  const nextSteps = [];
  if (!codexStatus.available) {
    nextSteps.push("Install Codex with `npm install -g @openai/codex`.");
  }
  if (codexStatus.available && !authStatus.loggedIn && authStatus.requiresOpenaiAuth) {
    nextSteps.push("Run `!codex login`.");
    nextSteps.push("If browser login is blocked, retry with `!codex login --device-auth` or `!codex login --with-api-key`.");
  }
  if (!config.stopReviewGate) {
    nextSteps.push("Optional: run `/cowork:setup --enable-review-gate` to require a fresh review before stop.");
  }

  return {
    ready: nodeStatus.available && codexStatus.available && authStatus.loggedIn,
    node: nodeStatus,
    npm: npmStatus,
    codex: codexStatus,
    auth: authStatus,
    sessionRuntime: getSessionRuntimeStatus(process.env, workspaceRoot),
    reviewGateEnabled: Boolean(config.stopReviewGate),
    actionsTaken,
    nextSteps
  };
}

async function handleSetup(argv) {
  const { options } = parseCommandInput(argv, {
    valueOptions: ["cwd"],
    booleanOptions: ["json", "enable-review-gate", "disable-review-gate"]
  });

  if (options["enable-review-gate"] && options["disable-review-gate"]) {
    throw new Error("Choose either --enable-review-gate or --disable-review-gate.");
  }

  const cwd = resolveCommandCwd(options);
  const workspaceRoot = resolveCommandWorkspace(options);
  const actionsTaken = [];

  if (options["enable-review-gate"]) {
    setConfig(workspaceRoot, "stopReviewGate", true);
    actionsTaken.push(`Enabled the stop-time review gate for ${workspaceRoot}.`);
  } else if (options["disable-review-gate"]) {
    setConfig(workspaceRoot, "stopReviewGate", false);
    actionsTaken.push(`Disabled the stop-time review gate for ${workspaceRoot}.`);
  }

  const finalReport = await buildSetupReport(cwd, actionsTaken);
  outputResult(options.json ? finalReport : renderSetupReport(finalReport), options.json);
}

function buildAdversarialReviewPrompt(context, focusText) {
  const template = loadPromptTemplate(ROOT_DIR, "adversarial-review");
  return interpolateTemplate(template, {
    REVIEW_KIND: "Adversarial Review",
    TARGET_LABEL: context.target.label,
    USER_FOCUS: focusText || "No extra focus provided.",
    REVIEW_COLLECTION_GUIDANCE: context.collectionGuidance,
    REVIEW_INPUT: context.content
  });
}

function ensureCodexAvailable(cwd) {
  const availability = getCodexAvailability(cwd);
  if (!availability.available) {
    throw new Error("Codex CLI is not installed or is missing required runtime support. Install it with `npm install -g @openai/codex`, then rerun `/cowork:setup`.");
  }
}

function buildNativeReviewTarget(target) {
  if (target.mode === "working-tree") {
    return { type: "uncommittedChanges" };
  }

  if (target.mode === "branch") {
    return { type: "baseBranch", branch: target.baseRef };
  }

  return null;
}

function validateNativeReviewRequest(target, focusText) {
  if (focusText.trim()) {
    throw new Error(
      `\`/cowork:code-review\` now maps directly to the built-in reviewer and does not support custom focus text. Retry with \`/cowork:adversarial-review ${focusText.trim()}\` for focused review instructions.`
    );
  }

  const nativeTarget = buildNativeReviewTarget(target);
  if (!nativeTarget) {
    throw new Error("This `/cowork:code-review` target is not supported by the built-in reviewer. Retry with `/cowork:adversarial-review` for custom targeting.");
  }

  return nativeTarget;
}

function renderStatusPayload(report, asJson) {
  return asJson ? report : renderStatusReport(report);
}

function isActiveJobStatus(status) {
  return status === "queued" || status === "running";
}

function getCurrentClaudeSessionId() {
  return process.env[SESSION_ID_ENV] ?? null;
}

function filterJobsForCurrentClaudeSession(jobs) {
  const sessionId = getCurrentClaudeSessionId();
  if (!sessionId) {
    return jobs;
  }
  return jobs.filter((job) => job.sessionId === sessionId);
}

function findLatestResumableTaskJob(jobs) {
  return (
    jobs.find(
      (job) =>
        job.jobClass === "task" &&
        job.threadId &&
        job.status !== "queued" &&
        job.status !== "running"
    ) ?? null
  );
}

async function waitForSingleJobSnapshot(cwd, reference, options = {}) {
  const timeoutMs = Math.max(0, Number(options.timeoutMs) || DEFAULT_STATUS_WAIT_TIMEOUT_MS);
  const pollIntervalMs = Math.max(100, Number(options.pollIntervalMs) || DEFAULT_STATUS_POLL_INTERVAL_MS);
  const deadline = Date.now() + timeoutMs;
  let snapshot = buildSingleJobSnapshot(cwd, reference);

  while (isActiveJobStatus(snapshot.job.status) && Date.now() < deadline) {
    await sleep(Math.min(pollIntervalMs, Math.max(0, deadline - Date.now())));
    snapshot = buildSingleJobSnapshot(cwd, reference);
  }

  return {
    ...snapshot,
    waitTimedOut: isActiveJobStatus(snapshot.job.status),
    timeoutMs
  };
}

async function resolveLatestTrackedTaskThread(cwd, options = {}) {
  const workspaceRoot = resolveWorkspaceRoot(cwd);
  const sessionId = getCurrentClaudeSessionId();
  const jobs = sortJobsNewestFirst(listJobs(workspaceRoot)).filter((job) => job.id !== options.excludeJobId);
  const visibleJobs = filterJobsForCurrentClaudeSession(jobs);
  const activeTask = visibleJobs.find((job) => job.jobClass === "task" && (job.status === "queued" || job.status === "running"));
  if (activeTask) {
    throw new Error(`Task ${activeTask.id} is still running. Use /cowork:status before continuing it.`);
  }

  const trackedTask = findLatestResumableTaskJob(visibleJobs);
  if (trackedTask) {
    return { id: trackedTask.threadId };
  }

  if (sessionId) {
    return null;
  }

  return findLatestTaskThread(workspaceRoot);
}

async function executeReviewRun(request) {
  ensureCodexAvailable(request.cwd);
  ensureGitRepository(request.cwd);

  const target = resolveReviewTarget(request.cwd, {
    base: request.base,
    scope: request.scope
  });
  const focusText = request.focusText?.trim() ?? "";
  const reviewName = request.reviewName ?? "Review";
  if (reviewName === "Review") {
    const reviewTarget = validateNativeReviewRequest(target, focusText);
    const { result, fellBackFrom, usedModel } = await withResilience(
      request.model ?? null,
      (currentModel) =>
        runAppServerReview(request.cwd, {
          target: reviewTarget,
          model: currentModel,
          onProgress: request.onProgress
        }),
      {
        onFallback: (from, to, error) => {
          if (request.onProgress) {
            request.onProgress({
              message: `Review model ${from} unavailable (${error?.message ?? "error"}); falling back to ${to}.`,
              phase: "fallback"
            });
          }
        },
        transient: { maxAttempts: 3, baseDelayMs: 1500 }
      }
    );
    if (fellBackFrom) {
      result.fallbackFrom = fellBackFrom;
      result.usedModel = usedModel;
    }
    const reviewTokenUsage = extractTokenUsage(result.turn);
    const payload = {
      review: reviewName,
      target,
      threadId: result.threadId,
      sourceThreadId: result.sourceThreadId,
      codex: {
        status: result.status,
        stderr: result.stderr,
        stdout: result.reviewText,
        reasoning: result.reasoningSummary
      },
      tokenUsage: reviewTokenUsage,
      modelUsed: usedModel ?? request.model ?? null,
      fallbackFrom: fellBackFrom ?? null
    };
    const rendered = renderNativeReviewResult(
      {
        status: result.status,
        stdout: result.reviewText,
        stderr: result.stderr
      },
      { reviewLabel: reviewName, targetLabel: target.label, reasoningSummary: result.reasoningSummary }
    );

    return {
      exitStatus: result.status,
      threadId: result.threadId,
      turnId: result.turnId,
      payload,
      rendered,
      summary: firstMeaningfulLine(result.reviewText, `${reviewName} completed.`),
      jobTitle: `Codex ${reviewName}`,
      jobClass: "review",
      targetLabel: target.label
    };
  }

  const context = collectReviewContext(request.cwd, target);
  const prompt = buildAdversarialReviewPrompt(context, focusText);
  const { result: advResult, fellBackFrom: advFellBackFrom, usedModel: advUsedModel } = await withResilience(
    request.model ?? null,
    (currentModel) =>
      runAppServerTurn(context.repoRoot, {
        prompt,
        model: currentModel,
        sandbox: "danger-full-access",
        outputSchema: readOutputSchema(REVIEW_SCHEMA),
        onProgress: request.onProgress
      }),
    {
      onFallback: (from, to, error) => {
        if (request.onProgress) {
          request.onProgress({
            message: `Adversarial review model ${from} unavailable (${error?.message ?? "error"}); falling back to ${to}.`,
            phase: "fallback"
          });
        }
      },
      transient: { maxAttempts: 3, baseDelayMs: 1500 }
    }
  );
  if (advFellBackFrom) {
    advResult.fallbackFrom = advFellBackFrom;
    advResult.usedModel = advUsedModel;
  }
  const advTokenUsage = extractTokenUsage(advResult.turn);
  const parsed = parseStructuredOutput(advResult.finalMessage, {
    status: advResult.status,
    failureMessage: advResult.error?.message ?? advResult.stderr
  });
  const payload = {
    review: reviewName,
    target,
    threadId: advResult.threadId,
    context: {
      repoRoot: context.repoRoot,
      branch: context.branch,
      summary: context.summary
    },
    codex: {
      status: advResult.status,
      stderr: advResult.stderr,
      stdout: advResult.finalMessage,
      reasoning: advResult.reasoningSummary
    },
    result: parsed.parsed,
    rawOutput: parsed.rawOutput,
    parseError: parsed.parseError,
    reasoningSummary: advResult.reasoningSummary,
    tokenUsage: advTokenUsage,
    modelUsed: advUsedModel ?? request.model ?? null,
    fallbackFrom: advFellBackFrom ?? null
  };

  return {
    exitStatus: advResult.status,
    threadId: advResult.threadId,
    turnId: advResult.turnId,
    payload,
    rendered: renderReviewResult(parsed, {
      reviewLabel: reviewName,
      targetLabel: context.target.label,
      reasoningSummary: advResult.reasoningSummary
    }),
    summary: parsed.parsed?.summary ?? parsed.parseError ?? firstMeaningfulLine(advResult.finalMessage, `${reviewName} finished.`),
    jobTitle: `Codex ${reviewName}`,
    jobClass: "review",
    targetLabel: context.target.label
  };
}


// Parse cowork-meta from a prompt (if present) to extract flow/role/owner/etc.
// Used to write heartbeat ledger entries so the lead can verify Codex actually
// dispatched — closes the "bypass Codex" bug where a teammate could respond
// without ever invoking this function.
function extractCoworkMeta(prompt) {
  if (typeof prompt !== "string") return null;
  const m = /<cowork-meta\b([^>]*)\/?>/i.exec(prompt);
  if (!m) return null;
  const attrs = {};
  const attrRe = /(\w[\w-]*)\s*=\s*"([^"]*)"/g;
  let a;
  while ((a = attrRe.exec(m[1])) !== null) {
    attrs[a[1].toLowerCase()] = a[2];
  }
  return attrs;
}

async function executeTaskRun(request) {
  const workspaceRoot = resolveWorkspaceRoot(request.cwd);
  ensureCodexAvailable(request.cwd);

  const taskMetadata = buildTaskRunMetadata({
    prompt: request.prompt,
    resumeLast: request.resumeLast
  });

  let resumeThreadId = null;
  if (request.resumeLast) {
    const latestThread = await resolveLatestTrackedTaskThread(workspaceRoot, {
      excludeJobId: request.jobId
    });
    if (!latestThread) {
      throw new Error("No previous Codex task thread was found for this repository.");
    }
    resumeThreadId = latestThread.id;
  }

  if (!request.prompt && !resumeThreadId) {
    throw new Error("Provide a prompt, a prompt file, piped stdin, or use --resume-last.");
  }

  // Heartbeat: write a dispatch_start ledger entry BEFORE calling Codex.
  // If the prompt has a <cowork-meta flow="..."/> tag, use its flow;
  // otherwise use a synthetic flow id so the entry is still discoverable.
  const coworkMeta = extractCoworkMeta(request.prompt);
  const heartbeatFlow = coworkMeta?.flow || `_job-${request.jobId || "adhoc"}`;
  const heartbeatRole = coworkMeta?.role || "task";
  const heartbeatOwner = coworkMeta?.owner || "codex";

  // Soft-warn (stderr only, no ledger entry) when neither the embedded
  // <cowork-meta /> tag nor any MCP-injected attribution reached us. This is
  // the signature of a dispatch from a caller that intended per-teammate
  // attribution but was on a stale MCP schema (or simply forgot the tag).
  // Operators seeing this warning should either restart the session for a
  // fresh schema OR switch the caller to embed the tag in the prompt text
  // directly (cowork.md Rule 4b). No-op when the warning is suppressed.
  if (!coworkMeta?.owner && !coworkMeta?.flow && !process.env.COWORK_SUPPRESS_ATTRIBUTION_WARNING) {
    process.stderr.write(
      "[cowork] warning: dispatch has no attribution (owner/flow). Ledger will show owner=codex. " +
      "Embed <cowork-meta owner=\"...\" flow=\"...\" /> at top of prompt (cowork.md Rule 4b). " +
      "Set COWORK_SUPPRESS_ATTRIBUTION_WARNING=1 to silence.\n"
    );
  }
  const heartbeatExtras = {
    job_id: request.jobId || null,
    requested_model: request.model || null,
    requested_effort: request.effort || null,
    resume_last: Boolean(request.resumeLast),
    write: Boolean(request.write),
    source: "codex-companion.mjs task",
    ...(coworkMeta || {})
  };
  try {
    const { ledgerFile } = ensureLedgerStorage(workspaceRoot);
    appendLedgerEntry(
      ledgerFile,
      buildLedgerEntry({
        flowId: heartbeatFlow,
        phase: "codex_dispatch_start",
        owner: heartbeatOwner,
        extra: { ...heartbeatExtras, role: heartbeatRole }
      })
    );
  } catch {
    // Heartbeat write failure should not block the task. Log-only.
  }

  const { result, usedModel, fellBackFrom } = await withResilience(
    request.model ?? null,
    (currentModel) => {
      const isOriginal = currentModel === request.model;
      // On fallback hops we drop the resume thread (can't continue a
      // thread that was started under a different model) AND supply
      // DEFAULT_CONTINUE_PROMPT as a prompt if the user requested
      // resume-last without an explicit prompt — otherwise the fallback
      // attempt would fail with "A prompt is required".
      const fallbackPromptDefault = !isOriginal && !request.prompt ? DEFAULT_CONTINUE_PROMPT : "";
      return runAppServerTurn(workspaceRoot, {
        resumeThreadId: isOriginal ? resumeThreadId : null,
        prompt: request.prompt,
        defaultPrompt: isOriginal
          ? (resumeThreadId ? DEFAULT_CONTINUE_PROMPT : "")
          : fallbackPromptDefault,
        model: currentModel,
        effort: request.effort,
        sandbox: "danger-full-access",
        onProgress: request.onProgress,
        persistThread: true,
        threadName: (resumeThreadId && isOriginal)
          ? null
          : buildPersistentTaskThreadName(request.prompt || DEFAULT_CONTINUE_PROMPT)
      });
    },
    {
      onFallback: (from, to, error) => {
        if (request.onProgress) {
          request.onProgress({
            message: `Model ${from} unavailable (${error?.message ?? "error"}); falling back to ${to}.`,
            phase: "fallback"
          });
        }
      },
      transient: {
        maxAttempts: 3,
        baseDelayMs: 1500,
        onRetry: (attempt, error, delay) => {
          if (request.onProgress) {
            request.onProgress({
              message: `Transient error (${error?.message ?? "unknown"}); retry ${attempt} in ${delay}ms.`,
              phase: "retry"
            });
          }
        }
      }
    }
  );
  if (fellBackFrom) {
    result.fallbackFrom = fellBackFrom;
    result.usedModel = usedModel;
  }

  const tokenUsage = extractTokenUsage(result.turn);
  if (tokenUsage) {
    result.tokenUsage = tokenUsage;
  }

  // Heartbeat: matching dispatch_complete entry paired with the earlier
  // dispatch_start. Lead-side verification: any teammate that claims a Codex
  // result without a matching _complete entry in the ledger is suspect.
  try {
    const { ledgerFile } = ensureLedgerStorage(workspaceRoot);
    appendLedgerEntry(
      ledgerFile,
      buildLedgerEntry({
        flowId: heartbeatFlow,
        phase: "codex_dispatch_complete",
        owner: heartbeatOwner,
        extra: {
          ...heartbeatExtras,
          role: heartbeatRole,
          status: result.status,
          used_model: usedModel,
          fell_back_from: fellBackFrom || null,
          token_usage: tokenUsage || null,
          thread_id: result.threadId || null
        }
      })
    );
  } catch {
    // Non-fatal.
  }

  const rawOutput = typeof result.finalMessage === "string" ? result.finalMessage : "";
  const failureMessage = result.error?.message ?? result.stderr ?? "";
  const rendered = renderTaskResult(
    {
      rawOutput,
      failureMessage,
      reasoningSummary: result.reasoningSummary
    },
    {
      title: taskMetadata.title,
      jobId: request.jobId ?? null,
      write: Boolean(request.write)
    }
  );
  const payload = {
    status: result.status,
    threadId: result.threadId,
    rawOutput,
    touchedFiles: result.touchedFiles,
    reasoningSummary: result.reasoningSummary,
    tokenUsage: result.tokenUsage ?? null,
    modelUsed: result.usedModel ?? request.model ?? null,
    fallbackFrom: result.fallbackFrom ?? null
  };

  return {
    exitStatus: result.status,
    threadId: result.threadId,
    turnId: result.turnId,
    payload,
    rendered,
    summary: firstMeaningfulLine(rawOutput, firstMeaningfulLine(failureMessage, `${taskMetadata.title} finished.`)),
    jobTitle: taskMetadata.title,
    jobClass: "task",
    write: Boolean(request.write)
  };
}

function buildReviewJobMetadata(reviewName, target) {
  return {
    kind: reviewName === "Adversarial Review" ? "adversarial-review" : "review",
    title: reviewName === "Review" ? "Codex Review" : `Codex ${reviewName}`,
    summary: `${reviewName} ${target.label}`
  };
}

function buildTaskRunMetadata({ prompt, resumeLast = false }) {
  if (!resumeLast && String(prompt ?? "").includes(STOP_REVIEW_TASK_MARKER)) {
    return {
      title: "Codex Stop Gate Review",
      summary: "Stop-gate review of previous Claude turn"
    };
  }

  const title = resumeLast ? "Codex Resume" : "Codex Task";
  const fallbackSummary = resumeLast ? DEFAULT_CONTINUE_PROMPT : "Task";
  return {
    title,
    summary: shorten(prompt || fallbackSummary)
  };
}

function renderQueuedTaskLaunch(payload) {
  return `${payload.title} started in the background as ${payload.jobId}. Check /cowork:status ${payload.jobId} for progress.\n`;
}

function getJobKindLabel(kind, jobClass) {
  if (kind === "adversarial-review") {
    return "adversarial-review";
  }
  return jobClass === "review" ? "review" : "rescue";
}

function createCompanionJob({ prefix, kind, title, workspaceRoot, jobClass, summary, write = false }) {
  return createJobRecord({
    id: generateJobId(prefix),
    kind,
    kindLabel: getJobKindLabel(kind, jobClass),
    title,
    workspaceRoot,
    jobClass,
    summary,
    write
  });
}

function createTrackedProgress(job, options = {}) {
  const logFile = options.logFile ?? createJobLogFile(job.workspaceRoot, job.id, job.title);
  return {
    logFile,
    progress: createProgressReporter({
      stderr: Boolean(options.stderr),
      logFile,
      onEvent: createJobProgressUpdater(job.workspaceRoot, job.id)
    })
  };
}

function buildTaskJob(workspaceRoot, taskMetadata, write) {
  return createCompanionJob({
    prefix: "task",
    kind: "task",
    title: taskMetadata.title,
    workspaceRoot,
    jobClass: "task",
    summary: taskMetadata.summary,
    write
  });
}

function buildTaskRequest({ cwd, model, effort, prompt, write, resumeLast, jobId }) {
  return {
    cwd,
    model,
    effort,
    prompt,
    write,
    resumeLast,
    jobId
  };
}

function readTaskPrompt(cwd, options, positionals) {
  if (options["prompt-file"]) {
    return fs.readFileSync(path.resolve(cwd, options["prompt-file"]), "utf8");
  }

  const positionalPrompt = positionals.join(" ");
  return positionalPrompt || readStdinIfPiped();
}

function requireTaskRequest(prompt, resumeLast) {
  if (!prompt && !resumeLast) {
    throw new Error("Provide a prompt, a prompt file, piped stdin, or use --resume-last.");
  }
}

async function runForegroundCommand(job, runner, options = {}) {
  const { logFile, progress } = createTrackedProgress(job, {
    logFile: options.logFile,
    stderr: !options.json
  });
  const execution = await runTrackedJob(job, () => runner(progress), { logFile });
  outputResult(options.json ? execution.payload : execution.rendered, options.json);
  if (execution.exitStatus !== 0) {
    process.exitCode = execution.exitStatus;
  }
  return execution;
}

function spawnDetachedTaskWorker(cwd, jobId) {
  const scriptPath = path.join(ROOT_DIR, "scripts", "codex-companion.mjs");
  const child = spawn(process.execPath, [scriptPath, "task-worker", "--cwd", cwd, "--job-id", jobId], {
    cwd,
    env: process.env,
    detached: true,
    stdio: "ignore",
    windowsHide: true
  });
  child.unref();
  return child;
}

function enqueueBackgroundTask(cwd, job, request) {
  const { logFile } = createTrackedProgress(job);
  appendLogLine(logFile, "Queued for background execution.");

  const child = spawnDetachedTaskWorker(cwd, job.id);
  const queuedRecord = {
    ...job,
    status: "queued",
    phase: "queued",
    pid: child.pid ?? null,
    logFile,
    request
  };
  writeJobFile(job.workspaceRoot, job.id, queuedRecord);
  upsertJob(job.workspaceRoot, queuedRecord);

  return {
    payload: {
      jobId: job.id,
      status: "queued",
      title: job.title,
      summary: job.summary,
      logFile
    },
    logFile
  };
}

async function handleReviewCommand(argv, config) {
  const { options, positionals } = parseCommandInput(argv, {
    valueOptions: ["base", "scope", "model", "cwd"],
    booleanOptions: ["json", "background", "wait"],
    aliasMap: {
      m: "model"
    }
  });

  const cwd = resolveCommandCwd(options);
  const workspaceRoot = resolveCommandWorkspace(options);
  const focusText = positionals.join(" ").trim();
  const target = resolveReviewTarget(cwd, {
    base: options.base,
    scope: options.scope
  });

  config.validateRequest?.(target, focusText);
  const metadata = buildReviewJobMetadata(config.reviewName, target);
  const job = createCompanionJob({
    prefix: "review",
    kind: metadata.kind,
    title: metadata.title,
    workspaceRoot,
    jobClass: "review",
    summary: metadata.summary
  });
  await runForegroundCommand(
    job,
    (progress) =>
      executeReviewRun({
        cwd,
        base: options.base,
        scope: options.scope,
        model: options.model,
        focusText,
        reviewName: config.reviewName,
        onProgress: progress
      }),
    { json: options.json }
  );
}

async function handleReview(argv) {
  return handleReviewCommand(argv, {
    reviewName: "Review",
    validateRequest: validateNativeReviewRequest
  });
}

async function handleTask(argv) {
  const { options, positionals } = parseCommandInput(argv, {
    valueOptions: ["model", "effort", "cwd", "prompt-file"],
    booleanOptions: ["json", "write", "resume-last", "resume", "fresh", "background"],
    aliasMap: {
      m: "model"
    }
  });

  const cwd = resolveCommandCwd(options);
  const workspaceRoot = resolveCommandWorkspace(options);
  const model = normalizeRequestedModel(options.model);
  const effort = normalizeReasoningEffort(options.effort);
  const prompt = readTaskPrompt(cwd, options, positionals);

  const resumeLast = Boolean(options["resume-last"] || options.resume);
  const fresh = Boolean(options.fresh);
  if (resumeLast && fresh) {
    throw new Error("Choose either --resume/--resume-last or --fresh.");
  }
  const write = Boolean(options.write);
  const taskMetadata = buildTaskRunMetadata({
    prompt,
    resumeLast
  });

  if (options.background) {
    ensureCodexAvailable(cwd);
    requireTaskRequest(prompt, resumeLast);

    const job = buildTaskJob(workspaceRoot, taskMetadata, write);
    const request = buildTaskRequest({
      cwd,
      model,
      effort,
      prompt,
      write,
      resumeLast,
      jobId: job.id
    });
    const { payload } = enqueueBackgroundTask(cwd, job, request);
    outputCommandResult(payload, renderQueuedTaskLaunch(payload), options.json);
    return;
  }

  const job = buildTaskJob(workspaceRoot, taskMetadata, write);
  await runForegroundCommand(
    job,
    (progress) =>
      executeTaskRun({
        cwd,
        model,
        effort,
        prompt,
        write,
        resumeLast,
        jobId: job.id,
        onProgress: progress
      }),
    { json: options.json }
  );
}

async function handleTaskWorker(argv) {
  const { options } = parseCommandInput(argv, {
    valueOptions: ["cwd", "job-id"]
  });

  if (!options["job-id"]) {
    throw new Error("Missing required --job-id for task-worker.");
  }

  const cwd = resolveCommandCwd(options);
  const workspaceRoot = resolveCommandWorkspace(options);
  const storedJob = readStoredJob(workspaceRoot, options["job-id"]);
  if (!storedJob) {
    throw new Error(`No stored job found for ${options["job-id"]}.`);
  }

  const request = storedJob.request;
  if (!request || typeof request !== "object") {
    throw new Error(`Stored job ${options["job-id"]} is missing its task request payload.`);
  }

  const { logFile, progress } = createTrackedProgress(
    {
      ...storedJob,
      workspaceRoot
    },
    {
      logFile: storedJob.logFile ?? null
    }
  );
  await runTrackedJob(
    {
      ...storedJob,
      workspaceRoot,
      logFile
    },
    () =>
      executeTaskRun({
        ...request,
        onProgress: progress
      }),
    { logFile }
  );
}

function handleLedgerAppend(argv) {
  const { options, positionals } = parseCommandInput(argv, {
    valueOptions: ["cwd"],
    booleanOptions: ["json"]
  });

  const [flowId, phase, owner, ...extraParts] = positionals;
  if (!flowId || !phase || !owner) {
    throw new Error("Usage: ledger append <flow-id> <phase> <owner> [extra-json]");
  }

  const workspaceRoot = resolveCommandWorkspace(options);
  const { ledgerFile } = ensureLedgerStorage(workspaceRoot);
  const extra = parseOptionalExtraJson(extraParts.join(" ").trim());
  const entry = buildLedgerEntry({ flowId, phase, owner, extra });
  appendLedgerEntry(ledgerFile, entry);

  const payload = {
    operation: "append",
    ledger_file: ledgerFile,
    entry
  };
  outputCommandResult(payload, renderLedgerAppend(payload), options.json);
}

function handleLedgerRead(argv) {
  const { options } = parseCommandInput(argv, {
    valueOptions: ["cwd", "flow", "last"],
    booleanOptions: ["json"]
  });

  const workspaceRoot = resolveCommandWorkspace(options);
  const { ledgerFile } = ensureLedgerStorage(workspaceRoot);
  const allEntries = readLedgerEntries(ledgerFile);
  const flowFilter = options.flow ? String(options.flow).trim() : "";
  const lastFlowCount = options.last == null ? null : parsePositiveInteger(options.last, "--last");

  let selectedEntries = allEntries;
  if (flowFilter) {
    selectedEntries = selectedEntries.filter((entry) => entry.flow_id === flowFilter);
  }
  if (lastFlowCount != null && !flowFilter) {
    selectedEntries = selectLastFlowEntries(selectedEntries, lastFlowCount);
  }
  selectedEntries = sortLedgerEntriesAscending(selectedEntries);
  const flows = summarizeLedgerFlows(selectedEntries);

  const payload = {
    operation: "read",
    ledger_file: ledgerFile,
    query: {
      flow: flowFilter || null,
      last: lastFlowCount
    },
    flow_count: flows.length,
    entry_count: selectedEntries.length,
    flows,
    entries: selectedEntries
  };

  outputCommandResult(payload, renderLedgerRead(payload), options.json);
}

function handleLedgerSummary(argv) {
  const { options } = parseCommandInput(argv, {
    valueOptions: ["cwd", "last"],
    booleanOptions: ["json"]
  });

  const workspaceRoot = resolveCommandWorkspace(options);
  const { ledgerFile } = ensureLedgerStorage(workspaceRoot);
  const allEntries = readLedgerEntries(ledgerFile);
  const lastFlowCount = options.last == null ? null : parsePositiveInteger(options.last, "--last");

  let selectedEntries = allEntries;
  if (lastFlowCount != null) {
    selectedEntries = selectLastFlowEntries(selectedEntries, lastFlowCount);
  }
  const flows = summarizeLedgerFlows(selectedEntries);

  const totalFlows = flows.length;
  const successfulFlows = flows.filter((flow) => flow.success_criteria_met).length;
  const fallbackFlows = flows.filter((flow) => flow.fallback_trigger_count > 0).length;
  const revisionCounts = flows.map((flow) => flow.ratify_revision_count);
  const codexShares = flows.map((flow) => flow.codex_compute_share);

  const stats = {
    total_flows: totalFlows,
    successful_flows: successfulFlows,
    success_rate: totalFlows ? Number((successfulFlows / totalFlows).toFixed(4)) : 0,
    fallback_flows: fallbackFlows,
    fallback_rate: totalFlows ? Number((fallbackFlows / totalFlows).toFixed(4)) : 0,
    avg_codex_compute_share: totalFlows
      ? Number((codexShares.reduce((acc, v) => acc + v, 0) / totalFlows).toFixed(4))
      : 0,
    avg_ratify_revisions: totalFlows
      ? Number((revisionCounts.reduce((acc, v) => acc + v, 0) / totalFlows).toFixed(4))
      : 0,
    max_ratify_revisions: revisionCounts.length ? Math.max(...revisionCounts) : 0,
    full_rewrite_flows: flows.filter((flow) => flow.ratify_full_rewrite).length
  };

  const payload = {
    operation: "summary",
    ledger_file: ledgerFile,
    query: { last: lastFlowCount },
    stats,
    flows
  };

  outputCommandResult(payload, renderLedgerSummary(payload), options.json);
}

function renderLedgerSummary(payload) {
  const { stats, flows } = payload;
  if (!flows.length) {
    return "No ledger entries found. Run /cowork first to populate the ledger.\n";
  }

  const pct = (value) => `${(value * 100).toFixed(1)}%`;
  const lines = [
    `Ledger summary: ${stats.total_flows} flow(s) inspected.`,
    `- Success (Codex owns P4+P6, ratify <=1 revision, no full rewrite): ${stats.successful_flows}/${stats.total_flows} (${pct(stats.success_rate)}) [target: >=80%]`,
    `- Fallbacks triggered: ${stats.fallback_flows}/${stats.total_flows} (${pct(stats.fallback_rate)})`,
    `- Full-rewrite ratifications: ${stats.full_rewrite_flows}/${stats.total_flows}`,
    `- Avg Codex compute share: ${pct(stats.avg_codex_compute_share)}`,
    `- Avg ratify revisions: ${stats.avg_ratify_revisions.toFixed(2)} (max: ${stats.max_ratify_revisions})`,
    ""
  ];

  const targetMet = stats.success_rate >= 0.8;
  lines.push(
    targetMet
      ? "Protocol health: OK — v1.4 success target met."
      : "Protocol health: BELOW TARGET — inspect individual flows below."
  );

  return `${lines.join("\n")}\n`;
}

// --- diagnose ------------------------------------------------------
//
// Heuristic-driven diagnostic over the recent ledger tail. Surfaces likely
// failure causes with specific remediation. Intended as a first stop when
// something feels off ("Codex seems quiet", "flow stuck", "lots of fallbacks").
//
// Heuristics (each returns an optional finding):
//   - codex_silence:    Codex dispatch rate near zero across recent entries.
//                       Signal: possible v4-era bypass regression.
//   - high_fallback:    Fallbacks triggered on > FALLBACK_WARN_RATIO of dispatches.
//                       Signal: model availability issue or flaky provider.
//   - failed_dispatches: Codex dispatches with status != "completed".
//                       Signal: transient errors worth inspecting.
//   - schema_drift:     Non-v1 schema_version observed but reader is v1.
//                       Signal: client/server mismatch.
//
// New findings should live in `runDiagnoseHeuristics` as small pure functions.

const DEFAULT_DIAGNOSE_ENTRY_WINDOW = 50;
const FALLBACK_WARN_RATIO = 0.2;
const CODEX_SILENCE_MIN_DISPATCHES = 1;

function runDiagnoseHeuristics(entries) {
  const findings = [];
  if (entries.length === 0) {
    return [
      {
        id: "empty_ledger",
        severity: "info",
        message: "Ledger is empty — no flows have run yet in this workspace.",
        remediation: "Run `/cowork <task>` to kick off a flow."
      }
    ];
  }

  const dispatchStarts = entries.filter((e) => e.phase === "codex_dispatch_start");
  const dispatchCompletes = entries.filter((e) => e.phase === "codex_dispatch_complete");
  const teamEvents = entries.filter((e) =>
    e.phase === "TeammateIdle" || e.phase === "TaskCreated" || e.phase === "TaskCompleted"
  );

  // codex_silence
  if (teamEvents.length >= 3 && dispatchStarts.length < CODEX_SILENCE_MIN_DISPATCHES) {
    findings.push({
      id: "codex_silence",
      severity: "high",
      message:
        `${teamEvents.length} team events but only ${dispatchStarts.length} codex_dispatch_start entries ` +
        `in the last ${entries.length} ledger lines.`,
      remediation:
        "Teammates may be answering without invoking codex_task (v4-era bypass regression). " +
        "Check that every teammate's initial prompt mandates codex_task use; re-spawn with Rule 3a role presets."
    });
  }

  // high_fallback
  const fallbacks = dispatchCompletes.filter((e) => e.fallback_triggered === true).length;
  if (dispatchCompletes.length > 0) {
    const ratio = fallbacks / dispatchCompletes.length;
    if (ratio > FALLBACK_WARN_RATIO) {
      findings.push({
        id: "high_fallback",
        severity: "medium",
        message: `Fallbacks triggered on ${fallbacks}/${dispatchCompletes.length} Codex dispatches (${(ratio * 100).toFixed(1)}%).`,
        remediation:
          "Preferred model may be unavailable. Check `codex_models` for current availability; " +
          "consider pinning to `gpt-5.3-codex` for stability or running `/cowork:setup` to refresh auth."
      });
    }
  }

  // failed_dispatches
  const failed = dispatchCompletes.filter((e) => {
    const status = e.extra?.status;
    return typeof status === "string" && status !== "completed" && status !== "success";
  });
  if (failed.length > 0) {
    findings.push({
      id: "failed_dispatches",
      severity: "medium",
      message: `${failed.length} Codex dispatches did not complete successfully.`,
      remediation:
        "Inspect with `node scripts/codex-companion.mjs ledger read --json --last 20` and look for " +
        "`status` fields != \"completed\". Common causes: prompt too long, model timeout, sandbox block."
    });
  }

  // schema_drift
  const unknownSchema = entries.filter((e) => typeof e.schema_version === "number" && e.schema_version > LEDGER_SCHEMA_VERSION);
  if (unknownSchema.length > 0) {
    findings.push({
      id: "schema_drift",
      severity: "low",
      message: `${unknownSchema.length} ledger entries carry a newer schema_version than this reader (${LEDGER_SCHEMA_VERSION}).`,
      remediation: "Plugin version mismatch across writers. Update to the latest cowork release."
    });
  }

  // unresolved_escalations — pair `escalate` events with `escalate_resolved`
  // by escalation_id; anything still open is a blocker the lead must handle
  // before advancing.
  const resolvedIds = new Set(
    entries
      .filter((e) => e.phase === "escalate_resolved" && e.extra?.escalation_id)
      .map((e) => e.extra.escalation_id)
  );
  const openEscalations = entries
    .filter((e) => e.phase === "escalate" && e.extra?.escalation_id && !resolvedIds.has(e.extra.escalation_id))
    .map((e) => ({
      id: e.extra.escalation_id,
      flow: e.flow_id,
      to: e.extra.to,
      reason: e.extra.reason,
      artifact_ref: e.extra.artifact_ref
    }));
  if (openEscalations.length > 0) {
    findings.push({
      id: "unresolved_escalations",
      severity: "high",
      message: `${openEscalations.length} escalation(s) open (awaiting resolution).`,
      remediation:
        "Route to human/lead per each escalation's `to` field. After decision, run " +
        "`ledger resolve <flow-id> <escalation-id> <decision>` to close the loop. " +
        "Open IDs: " + openEscalations.map((e) => e.id).join(", ")
    });
  }

  if (findings.length === 0) {
    findings.push({
      id: "healthy",
      severity: "info",
      message: `No issues detected across the last ${entries.length} ledger entries.`,
      remediation: ""
    });
  }
  return findings;
}

function handleLedgerDiagnose(argv) {
  const { options } = parseCommandInput(argv, {
    valueOptions: ["cwd", "last"],
    booleanOptions: ["json"]
  });
  const workspaceRoot = resolveCommandWorkspace(options);
  const { ledgerFile } = ensureLedgerStorage(workspaceRoot);
  const entryWindow = options.last
    ? parsePositiveInteger(options.last, "--last")
    : DEFAULT_DIAGNOSE_ENTRY_WINDOW;

  const allEntries = sortLedgerEntriesAscending(readLedgerEntries(ledgerFile));
  const tail = allEntries.slice(-entryWindow);
  const findings = runDiagnoseHeuristics(tail);

  const payload = {
    operation: "diagnose",
    ledger_file: ledgerFile,
    window: { entries_inspected: tail.length, entries_requested: entryWindow },
    findings
  };

  outputCommandResult(payload, renderLedgerDiagnose(payload), options.json);
}

function renderLedgerDiagnose(payload) {
  const { findings, window } = payload;
  const lines = [`Diagnose — inspected ${window.entries_inspected} recent ledger entries.`];
  const sevOrder = { high: 0, medium: 1, low: 2, info: 3 };
  const sorted = [...findings].sort((a, b) => (sevOrder[a.severity] ?? 99) - (sevOrder[b.severity] ?? 99));
  for (const f of sorted) {
    lines.push("");
    lines.push(`[${f.severity.toUpperCase()}] ${f.id}`);
    lines.push(`  ${f.message}`);
    if (f.remediation) lines.push(`  Remediation: ${f.remediation}`);
  }
  return `${lines.join("\n")}\n`;
}

// --- budget --------------------------------------------------------
//
// Token-usage rollup over the ledger. Aggregates token counts from
// `codex_dispatch_complete` entries (which carry `extra.token_usage`),
// grouped by owner, model, and phase.
//
// Limitation: only Codex-side tokens are persisted to the ledger today.
// Claude-side tokens are visible in Claude Code's own session logs but are
// not mirrored into the ledger — so the "Codex/Claude ratio" we compute is
// strictly "Codex token throughput". This is still useful for spotting
// under-utilization of Codex (Rule 2 target is 1:1) but is NOT a complete
// cost view. Users should cross-reference with their Claude Code session
// token counters for the full picture.

function sumTokenField(entries, field) {
  let sum = 0;
  let observed = 0;
  for (const e of entries) {
    const v = e?.extra?.token_usage?.[field];
    if (typeof v === "number" && Number.isFinite(v)) {
      sum += v;
      observed += 1;
    }
  }
  return { sum, observed };
}

function handleLedgerBudget(argv) {
  const { options } = parseCommandInput(argv, {
    valueOptions: ["cwd", "last", "since-hours"],
    booleanOptions: ["json"]
  });
  const workspaceRoot = resolveCommandWorkspace(options);
  const { ledgerFile } = ensureLedgerStorage(workspaceRoot);

  const allEntries = sortLedgerEntriesAscending(readLedgerEntries(ledgerFile));
  let tail = allEntries;

  if (options["since-hours"] != null) {
    const hours = parsePositiveInteger(options["since-hours"], "--since-hours");
    const cutoff = Date.now() - hours * 3600 * 1000;
    tail = tail.filter((e) => entryTimestampValue(e) >= cutoff);
  }
  if (options.last != null) {
    const n = parsePositiveInteger(options.last, "--last");
    tail = tail.slice(-n);
  }

  const completes = tail.filter((e) => e.phase === "codex_dispatch_complete");

  // Overall totals
  const totals = {
    input: sumTokenField(completes, "input").sum,
    output: sumTokenField(completes, "output").sum,
    total: sumTokenField(completes, "total").sum,
    reasoning: sumTokenField(completes, "reasoning").sum,
    cached: sumTokenField(completes, "cached").sum
  };

  // By model
  const byModel = {};
  for (const e of completes) {
    const model = e.extra?.used_model || "unknown";
    const cell = byModel[model] || { dispatches: 0, input: 0, output: 0, total: 0, reasoning: 0 };
    cell.dispatches += 1;
    cell.input += e.extra?.token_usage?.input || 0;
    cell.output += e.extra?.token_usage?.output || 0;
    cell.total += e.extra?.token_usage?.total || 0;
    cell.reasoning += e.extra?.token_usage?.reasoning || 0;
    byModel[model] = cell;
  }

  // By owner (who fired the dispatch)
  const byOwner = {};
  for (const e of completes) {
    const owner = e.owner || "unknown";
    const cell = byOwner[owner] || { dispatches: 0, total: 0 };
    cell.dispatches += 1;
    cell.total += e.extra?.token_usage?.total || 0;
    byOwner[owner] = cell;
  }

  const payload = {
    operation: "budget",
    ledger_file: ledgerFile,
    window: {
      entries_inspected: tail.length,
      completes_inspected: completes.length,
      since_hours: options["since-hours"] ?? null,
      last: options.last ?? null
    },
    totals,
    by_model: byModel,
    by_owner: byOwner,
    caveat:
      "Totals cover Codex-side tokens only (codex_dispatch_complete entries). Claude-side " +
      "tokens are not persisted to the ledger. For full cost accounting, cross-reference " +
      "with Claude Code's session token counters."
  };

  outputCommandResult(payload, renderLedgerBudget(payload), options.json);
}

function renderLedgerBudget(payload) {
  const { totals, by_model, by_owner, window, caveat } = payload;
  const fmt = (n) => n.toLocaleString();
  const lines = [`Codex token budget — ${window.completes_inspected} dispatches in last ${window.entries_inspected} ledger entries.`];

  lines.push("");
  lines.push("Totals:");
  lines.push(`  input:     ${fmt(totals.input)}`);
  lines.push(`  output:    ${fmt(totals.output)}`);
  lines.push(`  reasoning: ${fmt(totals.reasoning)}`);
  lines.push(`  total:     ${fmt(totals.total)}`);

  if (Object.keys(by_model).length) {
    lines.push("");
    lines.push("By model:");
    for (const [model, cell] of Object.entries(by_model)) {
      lines.push(`  ${model.padEnd(24)} ${cell.dispatches} dispatch(es) ${fmt(cell.total)} tokens`);
    }
  }

  if (Object.keys(by_owner).length) {
    lines.push("");
    lines.push("By owner (dispatcher):");
    for (const [owner, cell] of Object.entries(by_owner)) {
      lines.push(`  ${owner.padEnd(24)} ${cell.dispatches} dispatch(es) ${fmt(cell.total)} tokens`);
    }
  }

  lines.push("");
  lines.push(`Note: ${caveat}`);
  return `${lines.join("\n")}\n`;
}

function handleLedger(argv) {
  const [action, ...rest] = normalizeArgv(argv);
  if (!action || action === "help" || action === "--help") {
    throw new Error("Usage: ledger <append|read|summary|diagnose|budget> ...");
  }

  switch (action) {
    case "append":
      handleLedgerAppend(rest);
      break;
    case "read":
      handleLedgerRead(rest);
      break;
    case "summary":
      handleLedgerSummary(rest);
      break;
    case "diagnose":
      handleLedgerDiagnose(rest);
      break;
    case "budget":
      handleLedgerBudget(rest);
      break;
    case "escalate":
      handleLedgerEscalate(rest);
      break;
    case "resolve":
      handleLedgerResolve(rest);
      break;
    default:
      throw new Error(`Unknown ledger subcommand: ${action}`);
  }
}

// --- escalation protocol ------------------------------------------
//
// Canonical event shape (written by `ledger escalate`):
//   phase: "escalate"
//   owner: "<teammate-name>" (who is flagging uncertainty)
//   extra: {
//     to: "human" | "lead",                         // default "human"
//     reason: "<short explanation>",                // required
//     artifact_ref: "<file:line> or URL or null",   // optional pointer to the thing in question
//     escalation_id: "<uuid>"                       // minted here so a later `resolve` can reference it
//   }
//
// Resolve event:
//   phase: "escalate_resolved"
//   owner: "<resolver, usually lead or human>"
//   extra: {
//     escalation_id: "<uuid>",                      // must match an earlier escalate event
//     decision: "<free-text>"
//   }
//
// Lead-side contract: before routing new work, run `/cowork:diagnose` — the
// `unresolved_escalations` heuristic surfaces any open escalations so the lead
// can route them to the human instead of advancing past them silently.

function mintEscalationId() {
  // Short id, timestamp + random — no external uuid dependency.
  const rand = Math.random().toString(36).slice(2, 8);
  return `esc-${Date.now().toString(36)}-${rand}`;
}

function handleLedgerEscalate(argv) {
  const { options, positionals } = parseCommandInput(argv, {
    valueOptions: ["cwd", "to", "artifact-ref", "from"],
    booleanOptions: ["json"]
  });
  const [flowId, ...reasonParts] = positionals;
  const reason = reasonParts.join(" ").trim();
  if (!flowId || !reason) {
    throw new Error(
      "Usage: ledger escalate <flow-id> <reason...> [--to human|lead] [--from <teammate>] [--artifact-ref <pointer>]"
    );
  }

  const workspaceRoot = resolveCommandWorkspace(options);
  const { ledgerFile } = ensureLedgerStorage(workspaceRoot);
  const escalationId = mintEscalationId();

  const entry = buildLedgerEntry({
    flowId,
    phase: "escalate",
    owner: options.from ? String(options.from) : "teammate",
    extra: {
      to: options.to ? String(options.to) : "human",
      reason,
      artifact_ref: options["artifact-ref"] ? String(options["artifact-ref"]) : null,
      escalation_id: escalationId
    }
  });
  appendLedgerEntry(ledgerFile, entry);

  const payload = { operation: "escalate", entry, escalation_id: escalationId };
  outputCommandResult(
    payload,
    `Escalation ${escalationId} recorded for flow ${flowId} (to=${entry.extra.to}): ${reason}\n`,
    options.json
  );
}

function handleLedgerResolve(argv) {
  const { options, positionals } = parseCommandInput(argv, {
    valueOptions: ["cwd", "by"],
    booleanOptions: ["json"]
  });
  const [flowId, escalationId, ...decisionParts] = positionals;
  const decision = decisionParts.join(" ").trim();
  if (!flowId || !escalationId || !decision) {
    throw new Error(
      "Usage: ledger resolve <flow-id> <escalation-id> <decision...> [--by <resolver>]"
    );
  }

  const workspaceRoot = resolveCommandWorkspace(options);
  const { ledgerFile } = ensureLedgerStorage(workspaceRoot);
  const entry = buildLedgerEntry({
    flowId,
    phase: "escalate_resolved",
    owner: options.by ? String(options.by) : "lead",
    extra: { escalation_id: escalationId, decision }
  });
  appendLedgerEntry(ledgerFile, entry);

  const payload = { operation: "resolve", entry };
  outputCommandResult(
    payload,
    `Escalation ${escalationId} resolved (by ${entry.owner}): ${decision}\n`,
    options.json
  );
}

function runGitCommand(args, cwd) {
  const result = spawnSync("git", args, { cwd, encoding: "utf8" });
  return {
    status: result.status ?? 1,
    stdout: String(result.stdout || "").trim(),
    stderr: String(result.stderr || "").trim()
  };
}

function sanitizeForBranch(segment) {
  return String(segment).replace(/[^A-Za-z0-9._-]/g, "-").replace(/^-+|-+$/g, "");
}

function handleWorktreeEnsure(argv) {
  const { options, positionals } = parseCommandInput(argv, {
    valueOptions: ["cwd", "repo-path"],
    booleanOptions: ["json"]
  });
  const [flowId, phase] = positionals;
  if (!flowId || !phase) {
    throw new Error("Usage: worktree ensure <flow-id> <phase> [--repo-path <dir>] [--json]");
  }

  const repoPath = options["repo-path"]
    ? path.resolve(String(options["repo-path"]))
    : resolveCommandWorkspace(options);

  const safeFlow = sanitizeForBranch(flowId);
  const safePhase = sanitizeForBranch(phase);
  const branch = `cowork/${safeFlow}-${safePhase}`;
  const repoName = path.basename(repoPath);
  const worktreePath = path.resolve(repoPath, "..", `${repoName}-${safeFlow}-${safePhase}`);

  const insideRepo = runGitCommand(["rev-parse", "--is-inside-work-tree"], repoPath);
  const isGitRepo = insideRepo.status === 0 && insideRepo.stdout === "true";

  if (!isGitRepo) {
    const fallback = { provisioned: false, kind: "non-git-fallback", path: worktreePath, branch: null };
    if (!fs.existsSync(worktreePath)) {
      fs.mkdirSync(worktreePath, { recursive: true });
      fallback.provisioned = true;
    }
    outputCommandResult(
      fallback,
      `Non-git project. Using isolated cwd: ${worktreePath}\n`,
      options.json
    );
    return;
  }

  if (fs.existsSync(worktreePath)) {
    outputCommandResult(
      { provisioned: false, kind: "git-worktree", path: worktreePath, branch },
      `Worktree already present: ${worktreePath} (branch ${branch})\n`,
      options.json
    );
    return;
  }

  const add = runGitCommand(["worktree", "add", "-b", branch, worktreePath], repoPath);
  if (add.status !== 0) {
    throw new Error(`git worktree add failed: ${add.stderr || add.stdout}`);
  }

  outputCommandResult(
    { provisioned: true, kind: "git-worktree", path: worktreePath, branch },
    `Worktree provisioned: ${worktreePath} (branch ${branch})\n`,
    options.json
  );
}

function handleWorktreeCleanup(argv) {
  const { options, positionals } = parseCommandInput(argv, {
    valueOptions: ["cwd", "repo-path"],
    booleanOptions: ["json"]
  });
  const [flowId] = positionals;
  if (!flowId) {
    throw new Error("Usage: worktree cleanup <flow-id> [--repo-path <dir>] [--json]");
  }

  const repoPath = options["repo-path"]
    ? path.resolve(String(options["repo-path"]))
    : resolveCommandWorkspace(options);
  const safeFlow = sanitizeForBranch(flowId);
  const repoName = path.basename(repoPath);
  const parentDir = path.resolve(repoPath, "..");

  const insideRepo = runGitCommand(["rev-parse", "--is-inside-work-tree"], repoPath);
  const isGitRepo = insideRepo.status === 0 && insideRepo.stdout === "true";

  const removed = [];
  if (isGitRepo) {
    const list = runGitCommand(["worktree", "list", "--porcelain"], repoPath);
    if (list.status === 0) {
      const worktreePaths = list.stdout
        .split("\n")
        .filter((line) => line.startsWith("worktree "))
        .map((line) => line.slice("worktree ".length).trim());
      for (const wt of worktreePaths) {
        if (path.basename(wt).startsWith(`${repoName}-${safeFlow}-`)) {
          const remove = runGitCommand(["worktree", "remove", "--force", wt], repoPath);
          if (remove.status === 0) {
            removed.push({ path: wt, mode: "git-worktree" });
          }
        }
      }
    }
  } else {
    if (fs.existsSync(parentDir)) {
      for (const entry of fs.readdirSync(parentDir)) {
        if (entry.startsWith(`${repoName}-${safeFlow}-`)) {
          const p = path.join(parentDir, entry);
          fs.rmSync(p, { recursive: true, force: true });
          removed.push({ path: p, mode: "non-git-fallback" });
        }
      }
    }
  }

  outputCommandResult(
    { flow_id: flowId, removed },
    removed.length
      ? `Removed ${removed.length} worktree(s):\n${removed.map((r) => `- ${r.path}`).join("\n")}\n`
      : `No worktrees found for flow ${flowId}.\n`,
    options.json
  );
}

function handleWorktree(argv) {
  const [action, ...rest] = normalizeArgv(argv);
  if (!action || action === "help" || action === "--help") {
    throw new Error("Usage: worktree <ensure|cleanup> ...");
  }
  switch (action) {
    case "ensure":
      handleWorktreeEnsure(rest);
      break;
    case "cleanup":
      handleWorktreeCleanup(rest);
      break;
    default:
      throw new Error(`Unknown worktree subcommand: ${action}`);
  }
}

function handleThreadList(argv) {
  const { options } = parseCommandInput(argv, {
    valueOptions: ["cwd"],
    booleanOptions: ["json"]
  });
  const cwd = resolveCommandCwd(options);
  const jobs = listJobs(cwd);
  const threads = new Map();
  for (const job of jobs) {
    const threadId = job?.thread_id ?? job?.metadata?.thread_id ?? null;
    if (!threadId) continue;
    if (!threads.has(threadId)) {
      threads.set(threadId, {
        thread_id: threadId,
        first_job_id: job.id ?? null,
        latest_job_id: job.id ?? null,
        latest_completed_at: job.completed_at ?? null,
        job_count: 0
      });
    }
    const t = threads.get(threadId);
    t.job_count += 1;
    if (job.id) t.latest_job_id = job.id;
    if (job.completed_at) t.latest_completed_at = job.completed_at;
  }

  const list = [...threads.values()].sort((a, b) => {
    const delta = String(b.latest_completed_at || "").localeCompare(String(a.latest_completed_at || ""));
    return delta;
  });

  const payload = { operation: "thread-list", thread_count: list.length, threads: list };
  const rendered = list.length
    ? `${list.length} known thread(s):\n${list.map((t) => `- ${t.thread_id} (jobs: ${t.job_count}, latest: ${t.latest_completed_at || "n/a"})`).join("\n")}\n`
    : "No Codex threads recorded yet.\n";
  outputCommandResult(payload, rendered, options.json);
}

function handleThread(argv) {
  const [action, ...rest] = normalizeArgv(argv);
  if (!action || action === "help" || action === "--help") {
    throw new Error("Usage: thread <list> ...");
  }
  switch (action) {
    case "list":
      handleThreadList(rest);
      break;
    default:
      throw new Error(`Unknown thread subcommand: ${action}`);
  }
}

const DEFAULT_MODEL_ROUTING = {
  P1: { model: "gpt-5.4", effort: "xhigh", note: "Codex research — heavy constraint discovery" },
  P2: { model: "gpt-5.3-codex", effort: "medium", note: "Codex draft — medium preserves A/B epistemic diversity; raising converges drafts" },
  P3: { model: "gpt-5.3-codex", effort: "high", note: "Codex critique — cautious default; blind-spot detection benefits from effort" },
  P4: { model: "gpt-5.4", effort: "xhigh", note: "Codex synthesis — the core heavy-reasoning handoff" },
  P5: { model: null, effort: null, note: "Claude ratifies (supervisor, Opus 4.7 at user max); quality-floor enforcement" },
  P6: { model: "gpt-5.3-codex", effort: "high", note: "Codex build — cautious default; code that ships. Escalate to xhigh for complex tasks." },
  P7: { model: "gpt-5.4", effort: "high", note: "Codex review — reasoning-heavy; pro model + high effort as safety net" },
  P8: { model: "gpt-5.3-codex", effort: "high", note: "Codex-first fixes — cautious default on known-failing builds" }
};

const LEDGER_PHASE_SET = new Set(LEDGER_PHASES);

function parseEffortValue(value) {
  const normalized = String(value).trim().toLowerCase();
  if (!VALID_REASONING_EFFORTS.has(normalized)) {
    throw new Error(`Invalid effort: ${value}. Valid: ${[...VALID_REASONING_EFFORTS].join(", ")}`);
  }
  return normalized;
}

function parsePhaseValue(value) {
  const normalized = String(value).trim().toUpperCase();
  if (!LEDGER_PHASE_SET.has(normalized)) {
    throw new Error(`Invalid phase: ${value}. Valid: ${LEDGER_PHASES.join(", ")}`);
  }
  return normalized;
}

// Built-in defaults for the 11 user-facing hook config keys. Matches the
// skill table in commands/config.md and the fallbacks in each hook's
// config-read path. `config get` (no key) merges these with persisted
// overrides so the user sees the full effective config, not just the
// handful of keys they've customized. Keep in sync with the hook
// scripts (watch-reviewer-hook.mjs, pre-commit-gate-hook.mjs,
// prompt-research-hook.mjs, session-lifecycle-hook.mjs).
const CONFIG_DEFAULTS = {
  watch_enabled: true,
  watch_review_trivial: false,
  watch_inflight_cap: 2,
  pre_commit_gate: true,
  pre_commit_strict: true,
  prompt_research: true,
  prompt_research_angles: 3,
  prompt_research_model: "gpt-5.4",
  prompt_research_effort: "xhigh",
  session_start_findings: true,
  findings_max_age_days: 7
};

function handleConfigGet(argv) {
  const { options, positionals } = parseCommandInput(argv, {
    valueOptions: ["cwd"],
    booleanOptions: ["json"]
  });
  const cwd = resolveCommandCwd(options);
  const persisted = getConfig(cwd) || {};
  // Merge: built-in defaults → persisted overrides (overrides win). The
  // existing state-file default { stopReviewGate: false } already comes
  // through `persisted` via defaultState() in state.mjs, so we don't
  // re-declare it here.
  const merged = { ...CONFIG_DEFAULTS, ...persisted };
  const [key] = positionals;
  const payload = key
    ? { key, value: merged[key] ?? null, overridden: key in persisted }
    : { config: merged, overrides: persisted };
  const rendered = key
    ? `${key}: ${JSON.stringify(payload.value, null, 2)}${payload.overridden ? "" : " (default)"}\n`
    : `${JSON.stringify(merged, null, 2)}\n`;
  outputCommandResult(payload, rendered, options.json);
}

function handleConfigSet(argv) {
  const { options, positionals } = parseCommandInput(argv, {
    valueOptions: ["cwd"],
    booleanOptions: ["json"]
  });
  const [key, rawValue] = positionals;
  if (!key || rawValue === undefined) {
    throw new Error("Usage: config set <key> <value-json>");
  }
  let value;
  try {
    value = JSON.parse(rawValue);
  } catch {
    value = rawValue;
  }
  const cwd = resolveCommandCwd(options);
  setConfig(cwd, key, value);
  outputCommandResult(
    { operation: "set", key, value },
    `Set ${key} = ${JSON.stringify(value)}\n`,
    options.json
  );
}

function handleConfigReset(argv) {
  const { options, positionals } = parseCommandInput(argv, {
    valueOptions: ["cwd"],
    booleanOptions: ["json"]
  });
  const [key] = positionals;
  if (!key) {
    throw new Error("Usage: config reset <key>");
  }
  const cwd = resolveCommandCwd(options);
  clearConfig(cwd, key);
  const fallback = CONFIG_DEFAULTS[key];
  outputCommandResult(
    { operation: "reset", key, default: fallback ?? null },
    `Reset ${key} — default is ${fallback === undefined ? "(none, reader-specific)" : JSON.stringify(fallback)}\n`,
    options.json
  );
}

function handleConfigRoutingGet(argv) {
  const { options, positionals } = parseCommandInput(argv, {
    valueOptions: ["cwd"],
    booleanOptions: ["json"]
  });
  const cwd = resolveCommandCwd(options);
  const config = getConfig(cwd) || {};
  const overrides = config.model_routing || {};
  const merged = {};
  for (const phase of LEDGER_PHASES) {
    merged[phase] = { ...DEFAULT_MODEL_ROUTING[phase], ...(overrides[phase] || {}) };
  }
  const [phaseArg] = positionals;
  if (phaseArg) {
    const phase = parsePhaseValue(phaseArg);
    const payload = { phase, routing: merged[phase], source: overrides[phase] ? "override" : "default" };
    outputCommandResult(payload, `${phase}: ${JSON.stringify(merged[phase], null, 2)}\n`, options.json);
    return;
  }
  const payload = { defaults: DEFAULT_MODEL_ROUTING, overrides, merged };
  const lines = ["Model routing (defaults + user overrides merged):"];
  for (const phase of LEDGER_PHASES) {
    const r = merged[phase];
    const tag = overrides[phase] ? " [override]" : "";
    lines.push(`- ${phase}: model=${r.model || "(codex default)"} effort=${r.effort || "(codex default)"}${tag}`);
  }
  outputCommandResult(payload, `${lines.join("\n")}\n`, options.json);
}

function handleConfigRoutingSet(argv) {
  const { options, positionals } = parseCommandInput(argv, {
    valueOptions: ["cwd"],
    booleanOptions: ["json"]
  });
  const [phaseArg, modelArg, effortArg] = positionals;
  if (!phaseArg || !modelArg || !effortArg) {
    throw new Error("Usage: config routing set <phase> <model> <effort>");
  }
  const phase = parsePhaseValue(phaseArg);
  const model = modelArg === "none" || modelArg === "null" ? null : String(modelArg).trim();
  const effort = effortArg === "none" || effortArg === "null" ? null : parseEffortValue(effortArg);

  const cwd = resolveCommandCwd(options);
  const config = getConfig(cwd) || {};
  const routing = { ...(config.model_routing || {}) };
  routing[phase] = { model, effort };
  setConfig(cwd, "model_routing", routing);

  const payload = { operation: "routing-set", phase, model, effort };
  outputCommandResult(
    payload,
    `Set P${phase.replace(/^P/, "")} routing: model=${model || "(codex default)"} effort=${effort || "(codex default)"}\n`,
    options.json
  );
}

function handleConfigRoutingReset(argv) {
  const { options } = parseCommandInput(argv, {
    valueOptions: ["cwd"],
    booleanOptions: ["json"]
  });
  const cwd = resolveCommandCwd(options);
  setConfig(cwd, "model_routing", {});
  outputCommandResult(
    { operation: "routing-reset" },
    "Cleared all per-phase model_routing overrides. Defaults restored.\n",
    options.json
  );
}

function handleConfigRouting(argv) {
  const [action, ...rest] = normalizeArgv(argv);
  if (!action || action === "help" || action === "--help") {
    throw new Error("Usage: config routing <get|set|reset> ...");
  }
  switch (action) {
    case "get":
      handleConfigRoutingGet(rest);
      break;
    case "set":
      handleConfigRoutingSet(rest);
      break;
    case "reset":
      handleConfigRoutingReset(rest);
      break;
    default:
      throw new Error(`Unknown config routing subcommand: ${action}`);
  }
}

function handleConfig(argv) {
  const [action, ...rest] = normalizeArgv(argv);
  if (!action || action === "help" || action === "--help") {
    throw new Error("Usage: config <get|set|reset|routing> ...");
  }
  switch (action) {
    case "get":
      handleConfigGet(rest);
      break;
    case "set":
      handleConfigSet(rest);
      break;
    case "reset":
      handleConfigReset(rest);
      break;
    case "routing":
      handleConfigRouting(rest);
      break;
    default:
      throw new Error(`Unknown config subcommand: ${action}`);
  }
}

const WATCH_MARKER = "[cowork:watch-review]";

function handleWatchStart(argv) {
  const { options } = parseCommandInput(argv, {
    valueOptions: ["cwd", "throttle-ms", "model"],
    booleanOptions: ["json"]
  });
  const cwd = resolveCommandCwd(options);
  setConfig(cwd, "watch_enabled", true);
  if (options["throttle-ms"]) {
    const ms = parsePositiveInteger(options["throttle-ms"], "--throttle-ms");
    setConfig(cwd, "watch_throttle_ms", ms);
  }
  if (options.model) {
    setConfig(cwd, "watch_model", String(options.model).trim());
  }
  const config = getConfig(cwd) || {};
  const payload = {
    operation: "watch-start",
    watch_enabled: true,
    watch_throttle_ms: config.watch_throttle_ms ?? 60000,
    watch_model: config.watch_model ?? null
  };
  outputCommandResult(
    payload,
    `Watch mode enabled (throttle ${payload.watch_throttle_ms}ms per file${payload.watch_model ? `, model ${payload.watch_model}` : ""}).\n`,
    options.json
  );
}

function handleWatchStop(argv) {
  const { options } = parseCommandInput(argv, {
    valueOptions: ["cwd"],
    booleanOptions: ["json"]
  });
  const cwd = resolveCommandCwd(options);
  setConfig(cwd, "watch_enabled", false);
  outputCommandResult(
    { operation: "watch-stop", watch_enabled: false },
    "Watch mode disabled. Pending background reviews will still complete.\n",
    options.json
  );
}

function handleWatchStatus(argv) {
  const { options } = parseCommandInput(argv, {
    valueOptions: ["cwd"],
    booleanOptions: ["json"]
  });
  const cwd = resolveCommandCwd(options);
  const config = getConfig(cwd) || {};
  const throttleMs = config.watch_throttle_ms ?? 60000;
  const watchModel = config.watch_model ?? null;
  const throttlePath = path.join(cwd, ".cowork", "watch-throttle.json");
  let trackedFiles = 0;
  if (fs.existsSync(throttlePath)) {
    try {
      trackedFiles = Object.keys(JSON.parse(fs.readFileSync(throttlePath, "utf8"))).length;
    } catch {
      trackedFiles = 0;
    }
  }
  const payload = {
    operation: "watch-status",
    watch_enabled: Boolean(config.watch_enabled),
    watch_throttle_ms: throttleMs,
    watch_model: watchModel,
    tracked_files: trackedFiles
  };
  const lines = [
    `Watch mode: ${payload.watch_enabled ? "ENABLED" : "disabled"}`,
    `Throttle per file: ${throttleMs}ms`,
    `Model override: ${watchModel ?? "(use default routing)"}`,
    `Files with recent reviews tracked: ${trackedFiles}`
  ];
  outputCommandResult(payload, `${lines.join("\n")}\n`, options.json);
}

function handleWatch(argv) {
  const [action, ...rest] = normalizeArgv(argv);
  if (!action || action === "help" || action === "--help") {
    throw new Error("Usage: watch <start|stop|status> ...");
  }
  switch (action) {
    case "start":
      handleWatchStart(rest);
      break;
    case "stop":
      handleWatchStop(rest);
      break;
    case "status":
      handleWatchStatus(rest);
      break;
    default:
      throw new Error(`Unknown watch subcommand: ${action}`);
  }
}

function handleAccept(argv) {
  const { positionals } = parseCommandInput(argv, { valueOptions: [], booleanOptions: ["json"] });
  const cwd = resolveCommandCwd({});
  const ids = positionals.filter((p) => typeof p === "string" && p.length > 0);
  if (ids.length === 0) {
    throw new Error("Usage: accept <job-id> [<job-id>...]");
  }
  const coworkDir = path.join(cwd, ".cowork");
  if (!fs.existsSync(coworkDir)) fs.mkdirSync(coworkDir, { recursive: true });
  const acceptedPath = path.join(coworkDir, "findings-accepted.json");
  let existing = [];
  try {
    if (fs.existsSync(acceptedPath)) {
      const raw = JSON.parse(fs.readFileSync(acceptedPath, "utf8"));
      if (Array.isArray(raw)) existing = raw;
    }
  } catch {
    existing = [];
  }
  const set = new Set(existing);
  const added = [];
  for (const id of ids) {
    if (!set.has(id)) {
      set.add(id);
      added.push(id);
    }
  }
  const merged = Array.from(set);
  fs.writeFileSync(acceptedPath, JSON.stringify(merged, null, 2) + "\n", "utf8");
  const payload = {
    operation: "accept",
    accepted_ids: merged,
    newly_added: added,
    accepted_file: acceptedPath
  };
  const lines = [
    `Accepted ${added.length} new finding(s) (${merged.length} total).`,
    ...added.map((id) => `  + ${id}`)
  ];
  outputCommandResult(payload, lines.join("\n"), Boolean(argv?.includes?.("--json")));
}

function handleFindings(argv) {
  const { options } = parseCommandInput(argv, {
    valueOptions: ["cwd", "last"],
    booleanOptions: ["json"]
  });
  const cwd = resolveCommandCwd(options);
  const lastCount = options.last ? parsePositiveInteger(options.last, "--last") : 10;

  const jobs = listJobs(cwd).filter((job) => {
    const prompt = job?.request?.prompt ?? "";
    return typeof prompt === "string" && prompt.includes(WATCH_MARKER);
  });

  const sorted = sortJobsNewestFirst(jobs).slice(0, lastCount);

  const findings = sorted.map((job) => {
    const editedPath = (() => {
      const p = job?.request?.prompt ?? "";
      // The watch hook wraps the path in JSON.stringify, producing a quoted
      // string in the prompt. Match the quoted form first (handles spaces,
      // non-ASCII, special chars); fall back to the old unquoted regex for
      // backwards compat with earlier watch entries.
      const quoted = /Review ("(?:[^"\\]|\\.)+") for blockers/.exec(p);
      if (quoted) {
        try { return JSON.parse(quoted[1]); } catch { /* fall through */ }
      }
      const unquoted = /Review (\S+) for blockers/.exec(p);
      return unquoted ? unquoted[1] : null;
    })();
    const result = job?.result ?? {};
    return {
      job_id: job.id,
      status: job.status,
      completed_at: job.completedAt ?? null,
      edited_file: editedPath,
      model_used: result.modelUsed ?? job?.request?.model ?? null,
      token_usage: result.tokenUsage ?? null,
      summary: (result.rawOutput || "").slice(0, 500)
    };
  });

  const payload = {
    operation: "findings",
    count: findings.length,
    findings
  };

  const lines = [
    `Watch reviews: ${findings.length} recent (showing up to ${lastCount})`
  ];
  if (findings.length === 0) {
    lines.push("No watch-mode reviews have fired. Enable with `watch start`, then edit a file.");
  } else {
    for (const f of findings) {
      const tokenStr = f.token_usage?.total ? ` (${f.token_usage.total} tokens)` : "";
      lines.push(`- ${f.completed_at ?? "in progress"} [${f.status}] ${f.edited_file ?? "?"}${tokenStr}`);
      if (f.summary) {
        lines.push(`    ${f.summary.split("\n")[0].slice(0, 160)}`);
      }
    }
  }
  outputCommandResult(payload, `${lines.join("\n")}\n`, options.json);
}

async function handleStatus(argv) {
  const { options, positionals } = parseCommandInput(argv, {
    valueOptions: ["cwd", "timeout-ms", "poll-interval-ms"],
    booleanOptions: ["json", "all", "wait"]
  });

  const cwd = resolveCommandCwd(options);
  const reference = positionals[0] ?? "";
  if (reference) {
    const snapshot = options.wait
      ? await waitForSingleJobSnapshot(cwd, reference, {
          timeoutMs: options["timeout-ms"],
          pollIntervalMs: options["poll-interval-ms"]
        })
      : buildSingleJobSnapshot(cwd, reference);
    outputCommandResult(snapshot, renderJobStatusReport(snapshot.job), options.json);
    return;
  }

  if (options.wait) {
    throw new Error("`status --wait` requires a job id.");
  }

  const report = buildStatusSnapshot(cwd, { all: options.all });
  outputResult(renderStatusPayload(report, options.json), options.json);
}

function handleResult(argv) {
  const { options, positionals } = parseCommandInput(argv, {
    valueOptions: ["cwd"],
    booleanOptions: ["json"]
  });

  const cwd = resolveCommandCwd(options);
  const reference = positionals[0] ?? "";
  const { workspaceRoot, job } = resolveResultJob(cwd, reference);
  const storedJob = readStoredJob(workspaceRoot, job.id);
  const payload = {
    job,
    storedJob
  };

  outputCommandResult(payload, renderStoredJobResult(job, storedJob), options.json);
}

function handleTaskResumeCandidate(argv) {
  const { options } = parseCommandInput(argv, {
    valueOptions: ["cwd"],
    booleanOptions: ["json"]
  });

  const cwd = resolveCommandCwd(options);
  const workspaceRoot = resolveCommandWorkspace(options);
  const sessionId = getCurrentClaudeSessionId();
  const jobs = filterJobsForCurrentClaudeSession(sortJobsNewestFirst(listJobs(workspaceRoot)));
  const candidate = findLatestResumableTaskJob(jobs);

  const payload = {
    available: Boolean(candidate),
    sessionId,
    candidate:
      candidate == null
        ? null
        : {
            id: candidate.id,
            status: candidate.status,
            title: candidate.title ?? null,
            summary: candidate.summary ?? null,
            threadId: candidate.threadId,
            completedAt: candidate.completedAt ?? null,
            updatedAt: candidate.updatedAt ?? null
          }
  };

  const rendered = candidate
    ? `Resumable task found: ${candidate.id} (${candidate.status}).\n`
    : "No resumable task found for this session.\n";
  outputCommandResult(payload, rendered, options.json);
}

async function handleCancel(argv) {
  const { options, positionals } = parseCommandInput(argv, {
    valueOptions: ["cwd"],
    booleanOptions: ["json"]
  });

  const cwd = resolveCommandCwd(options);
  const reference = positionals[0] ?? "";
  const { workspaceRoot, job } = resolveCancelableJob(cwd, reference, { env: process.env });
  const existing = readStoredJob(workspaceRoot, job.id) ?? {};
  const threadId = existing.threadId ?? job.threadId ?? null;
  const turnId = existing.turnId ?? job.turnId ?? null;

  const interrupt = await interruptAppServerTurn(cwd, { threadId, turnId });
  if (interrupt.attempted) {
    appendLogLine(
      job.logFile,
      interrupt.interrupted
        ? `Requested Codex turn interrupt for ${turnId} on ${threadId}.`
        : `Codex turn interrupt failed${interrupt.detail ? `: ${interrupt.detail}` : "."}`
    );
  }

  terminateProcessTree(job.pid ?? Number.NaN);
  appendLogLine(job.logFile, "Cancelled by user.");

  const completedAt = nowIso();
  const nextJob = {
    ...job,
    status: "cancelled",
    phase: "cancelled",
    pid: null,
    completedAt,
    errorMessage: "Cancelled by user."
  };

  writeJobFile(workspaceRoot, job.id, {
    ...existing,
    ...nextJob,
    cancelledAt: completedAt
  });
  upsertJob(workspaceRoot, {
    id: job.id,
    status: "cancelled",
    phase: "cancelled",
    pid: null,
    errorMessage: "Cancelled by user.",
    completedAt
  });

  const payload = {
    jobId: job.id,
    status: "cancelled",
    title: job.title,
    turnInterruptAttempted: interrupt.attempted,
    turnInterrupted: interrupt.interrupted
  };

  outputCommandResult(payload, renderCancelReport(nextJob), options.json);
}

async function main() {
  const [subcommand, ...argv] = process.argv.slice(2);
  if (!subcommand || subcommand === "help" || subcommand === "--help") {
    printUsage();
    return;
  }

  switch (subcommand) {
    case "setup":
      await handleSetup(argv);
      break;
    case "review":
      await handleReview(argv);
      break;
    case "adversarial-review":
      await handleReviewCommand(argv, {
        reviewName: "Adversarial Review"
      });
      break;
    case "task":
      await handleTask(argv);
      break;
    case "task-worker":
      await handleTaskWorker(argv);
      break;
    case "status":
      await handleStatus(argv);
      break;
    case "result":
      handleResult(argv);
      break;
    case "task-resume-candidate":
      handleTaskResumeCandidate(argv);
      break;
    case "cancel":
      await handleCancel(argv);
      break;
    case "ledger":
      handleLedger(argv);
      break;
    case "worktree":
      handleWorktree(argv);
      break;
    case "thread":
      handleThread(argv);
      break;
    case "config":
      handleConfig(argv);
      break;
    case "watch":
      handleWatch(argv);
      break;
    case "findings":
      handleFindings(argv);
      break;
    case "accept":
      handleAccept(argv);
      break;
    default:
      throw new Error(`Unknown subcommand: ${subcommand}`);
  }
}

main().catch((error) => {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`${message}\n`);
  process.exitCode = 1;
});
