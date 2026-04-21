---
description: Full cowork protocol — Codex + Opus research in parallel, dual-plan + mutual critique, implementation, Codex review loop until sign-off. Use for non-trivial engineering work where an extra adversarial pair of eyes is worth the latency.
argument-hint: '<task description>'
allowed-tools: Bash(node:*), Task, Read, Write, Edit, Glob, Grep
---

The user has invoked the full cowork protocol. The task is in `$ARGUMENTS`.

You are Opus. You will execute a five-stage protocol where you and Codex (gpt-5.4, xhigh effort) each contribute, critique each other, and converge on a delivery. Every Codex dispatch goes through a **synchronous** (blocking) Bash call to `codex-companion`. You block each phase on its completion before moving to the next — do not advance a phase while work is still outstanding.

---

## Phase 1 — Parallel research (blocking)

Dispatch **four** Codex research agents *in parallel* plus **one** Opus research subagent, also in parallel. Single message, five tool calls at once. Wait for all five to return before advancing.

For Codex, each dispatch is a Bash call. Run the blocking form (no `--background`) so stdout is the final Codex answer:

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/codex-companion.mjs" task \
  --model gpt-5.4 --effort xhigh -- \
  "$(cat <<'PROMPT'
<cowork-meta owner="cowork" flow="cowork-protocol" role="research" />
<task>Research angle 1/4: prior-art patterns, libraries, and APIs relevant to: <TASK>. Cite concrete sources (docs URLs, RFCs, published papers, reference implementations). No speculation.</task>
<grounding_rules>Every claim cites file:line, docs URL, or paper. Return ≤800 words.</grounding_rules>
PROMPT
)"
```

Angle split — pick four that genuinely partition the surface of the problem. Starter taxonomy; adapt to the specific task:

1. **Prior art, libraries, canonical APIs.** What does the ecosystem already solve this with?
2. **Failure modes and edge cases.** Where do naive implementations break? What do battle-tested systems guard against?
3. **Performance, scale, resource characteristics.** What are the cost dimensions?
4. **Testing, acceptance, observability.** How is this verified at runtime and in CI?

Each angle gets its own Bash call with its own angle-specific prompt. The prompts share the `<cowork-meta>` block and the user's task.

For the **Opus research subagent** (the 5th parallel dispatch), use the Task tool with `subagent_type="general-purpose"` and a prompt that frames the same research question but approaches it from first principles — what you'd reason about if you had to design it from scratch, citing your own references. Do NOT just duplicate one of Codex's angles; go orthogonal.

Once all five return, consolidate the findings into your working context. Note which claims conflict between sources; mark unresolved questions.

---

## Phase 2 — Dual plans + mutual critique + master plan

**Step 2a.** Draft your own plan based on phase-1 research. The plan is **one level above code** — low-level enough to be concrete (named functions, data shapes, file paths), but not code. Cover: design, interfaces, data flow, error handling, test strategy, migration/rollout. Err on thoroughness; this is the artifact Codex will critique.

**Step 2b.** Dispatch Codex to produce a *separate* plan (parallel to yours), giving it the same research context:

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/codex-companion.mjs" task \
  --model gpt-5.4 --effort xhigh -- \
  "$(cat <<'PROMPT'
<cowork-meta owner="cowork" flow="cowork-protocol" role="planning" />
<task>Produce a low-level implementation plan for: <TASK>

Research context (synthesize from the findings below; do not re-research):
<RESEARCH FINDINGS FROM PHASE 1>

Produce a plan that is detailed enough to hand to an implementer. Cover: architecture, interfaces, data shapes, error paths, test strategy, rollout/migration. One level above code. No code. ≤1200 words.</task>
PROMPT
)"
```

Block until Codex returns its plan.

**Step 2c.** Critique Codex's plan. Write an explicit critique — what's weak, what's risky, what's missing, what you'd do differently and why.

**Step 2d.** Dispatch Codex with your plan and ask for *its* critique of yours:

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/codex-companion.mjs" task \
  --model gpt-5.4 --effort xhigh -- \
  "$(cat <<'PROMPT'
<cowork-meta owner="cowork" flow="cowork-protocol" role="plan-critique" />
<task>Critique the following implementation plan. Flag risks, gaps, weak assumptions, missing test coverage, brittle interfaces, and anything you would do differently. Cite specific line/section of the plan for each criticism. ≤800 words.

Plan under review:
<OPUS PLAN FROM STEP 2a>
</task>
PROMPT
)"
```

Block until Codex returns its critique.

**Step 2e.** Synthesize a **master plan** that incorporates both critiques. Every criticism from either side should either (a) be addressed in the master plan, or (b) be explicitly rejected in writing with a stated reason. No silent drops.

**Step 2f.** Present the master plan to the user. Ask for sign-off before proceeding to implementation. **Do not enter phase 3 without explicit user approval of the master plan.**

---

## Phase 3 — Opus implements

Execute the master plan using your standard tools (Read, Write, Edit, Bash, etc.). This is normal implementation work — no Codex dispatch in this phase. Stay within the plan's scope; if you discover a reason to deviate, note it in writing and flag it for review in phase 4.

Implementation-time discipline:
- Make the minimal changes the master plan calls for.
- Keep commits (if the user commits) logically grouped by plan section.
- Do not add scope that wasn't in the master plan without surfacing it explicitly.

When implementation is complete, move to phase 4. Do not skip review even if the change feels trivial — the whole point of the protocol is the review step.

---

## Phase 4 — Codex reviews

Dispatch Codex to review the implementation with full access to the diff and the master plan:

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/codex-companion.mjs" task \
  --model gpt-5.4 --effort xhigh --write -- \
  "$(cat <<'PROMPT'
<cowork-meta owner="cowork" flow="cowork-protocol" role="adversarial-review" />
<task>Adversarial review of the implementation in the current project against the master plan below. Full filesystem access; read every file you need. Flag:
- Deviations from the master plan (unless explicitly addressed)
- Bugs, race conditions, resource leaks, error-path gaps
- Missing or insufficient tests
- Security, injection, boundary violations
- Scope creep

Output shape: one finding per issue. Each finding: severity (BLOCKER/HIGH/MEDIUM/LOW), file:line citation, concrete description, suggested fix. End with a single-line verdict: "SIGNOFF" if no BLOCKER/HIGH findings remain; "BLOCKED: <short reason>" otherwise.

Master plan:
<MASTER PLAN FROM STEP 2e>
</task>
PROMPT
)"
```

Block until Codex returns. Note: `--write` is passed so Codex runs with full filesystem access to read project files during review; the prompt itself instructs Codex to stay read-only (review, not edit).

Parse the output:
- If the final line is `SIGNOFF`, proceed to end of protocol. Report completion to user.
- If the final line is `BLOCKED: ...`, advance to phase 5.

---

## Phase 5 — Opus fixes

Address every BLOCKER and HIGH finding from the Codex review. For MEDIUM/LOW findings, address them unless there's a documented reason to defer (e.g., out of scope, already tracked elsewhere). If deferring, note the deferral explicitly.

When fixes are complete, loop back to phase 4.

---

## Phase 6+ — Re-review loop (cap at 5 iterations)

Re-dispatch Codex review as in phase 4. SIGNOFF → done. BLOCKED → back to phase 5.

**Hard cap: 5 review iterations total.** If Codex still returns BLOCKED after 5 iterations, stop and escalate to the user — explain which findings remain unresolved and ask how they want to proceed (accept the risk, re-plan, abandon, etc.).

---

## Rules (non-negotiable)

- **Blocking throughout.** Each phase waits for all prior dispatches to complete before advancing. No "fire and forget, Claude answers anyway."
- **Attribution.** Every Codex prompt carries `<cowork-meta owner="cowork" flow="cowork-protocol" role="..." />` so the cowork ledger tracks spend per phase.
- **Model + effort.** All Codex dispatches use `--model gpt-5.4 --effort xhigh`. Do not downgrade.
- **User sign-off gate.** The master plan (end of phase 2) requires explicit user approval before implementation. Nothing else does.
- **Transparency.** At the end of each phase, tell the user which phase just completed and which is next. Summarize what Codex said vs. what you said in a sentence or two.
- **Do not skip phases.** Even for "small" tasks. If the protocol is invoked, all phases run.
- **No fallbacks to single-agent.** If Codex is unavailable, stop and tell the user — don't silently degrade to Opus-only.
