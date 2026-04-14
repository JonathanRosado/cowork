# cowork

[![MIT License](https://img.shields.io/badge/license-MIT-green.svg)](LICENSE)
[![Claude Code](https://img.shields.io/badge/Claude%20Code-plugins-orange)](https://claude.com/claude-code)

**Make Claude and Codex actually work together.** Not one plans and the other reviews — both think, both build, both hold each other accountable.

A single self-contained Claude Code plugin that turns Claude (Opus) and Codex (GPT-5) into collaborating agents with shared project context, full tool access, and structured protocols for design, implementation, and review. Includes a forked unrestricted Codex runtime bundled directly into the plugin — **no separate codex install, no name collision with the upstream OpenAI codex plugin**.

## What's in the box

### `/cowork:cowork` — design + implement + settle

Two AI architects argue about your problem, converge on one plan, then one of them builds it while the other reviews.

```
/cowork:cowork add rate limiting to our public API
```

```
Rounds 1–2    Claude drafts.     Codex drafts.     Both critique.    (independent)
                    \                /
Round 3              Claude synthesizes → tags primary architect
                              |
Round 4              Codex signs off (with memory of its critique)
                              |
              Primary architect implements (Claude or Codex)
                              |
Rounds 5–7    Both review the implementation → settle or fix
```

**Key features:**
- **Provenance routing** — whichever agent's thinking dominated the plan implements it, because it has the deeper mental model of *why* the solution is shaped that way
- **Hybrid threading** — early rounds are independent (blind drafts, unanchored critiques) for epistemic diversity; later rounds resume the same Codex thread for continuity
- **User override** — reply `claude implements` or `codex implements` after the plan to route manually. Say `switch to claude` or `switch to codex` mid-implementation to hand off
- **Plan mode aware** — if you're in plan mode, it stops after Round 4 with the converged plan. If not, it goes all the way through implementation and settlement

### `/cowork:question` — parallel research + synthesis

Both agents independently research the same question using their full toolsets, then Claude synthesizes the answers.

```
/cowork:question does the Nebius provider support attaching shared filesystems to K8s node groups?
```

- Both agents read files, run commands, hit APIs — independently and in parallel
- Claude synthesizes: where they agreed, where they disagreed, evidence quality
- If disputes exist, Codex verifies the specific claims in a follow-up round

Good for questions where you want a second opinion backed by independent evidence, not just a second phrasing of the same guess.

### `/cowork:review` — implement then both-agent review

Claude implements, then both Claude and Codex review the implementation in parallel and settle on whether it meets the plan.

### Bundled unrestricted Codex runtime

The `cowork` plugin bundles a forked Codex runtime — the same `codex-companion.mjs` + app-server broker used by the upstream OpenAI plugin, with three changes:

1. **No sandbox.** Full filesystem and network access. Codex can run your CLI tools, call APIs, `curl` endpoints, read any file. No bubblewrap, no DNS blocks, no cryptic permission errors.
2. **Project-aware.** The `cowork:codex-rescue` agent reads your project structure, `CLAUDE.md`, and `CHANGELOG.md` before every Codex invocation. Codex sees your project context automatically — no manual pasting.
3. **Windows-safe spawn.** The upstream plugin fails on Windows with `spawn codex ENOENT` because Node's `spawn()` doesn't resolve `.cmd` extensions without `shell: true`. This fork fixes it.

### All commands in one plugin

| Command | Purpose |
|---|---|
| `/cowork:cowork` | Full design → implement → settle protocol |
| `/cowork:question` | Parallel research + synthesis |
| `/cowork:review` | Implementation review protocol |
| `/cowork:rescue` | Delegate a rescue task to Codex directly |
| `/cowork:code-review` | Codex code review (was `/codex:review` upstream) |
| `/cowork:setup` | Check Codex CLI readiness |
| `/cowork:status` | Check status of running Codex tasks |
| `/cowork:cancel` | Cancel a running Codex task |
| `/cowork:result` | Fetch the result of a completed Codex task |
| `/cowork:adversarial-review` | Adversarial code review |

The agent is `cowork:codex-rescue` (used by `/cowork:cowork` and `/cowork:question` internally).

## Install

### Prerequisites

- [Claude Code](https://claude.com/claude-code)
- [Codex CLI](https://github.com/openai/codex) installed and authenticated (`codex login`)

### Step 1 — (optional) Remove the upstream OpenAI Codex plugin

Since `cowork` v1.2.0 bundles the Codex runtime into the `cowork` plugin itself (avoiding the name collision that plagued v1.1.0), you can leave the upstream `codex@openai-codex` plugin installed or remove it — they no longer conflict. If you want a clean setup with only `cowork`, remove the upstream:

```
/plugin uninstall codex@openai-codex
```

### Step 2 — Install

```
/plugin marketplace add JonathanRosado/cowork
/plugin install cowork@cc-plugins
/reload-plugins
```

One plugin. One install. Everything bundled.

### Step 3 — Verify

```
/cowork:question what project is this?
```

Codex should read your project files and answer without you pasting any context.

## Migration from v1.x

If you installed `cowork@cowork` + `codex@cowork` previously:

1. Uninstall the old split plugins: `/plugin uninstall codex@cc-plugins && /plugin uninstall cowork@cc-plugins`
2. Reinstall the merged plugin: `/plugin install cowork@cc-plugins`
3. Reload: `/reload-plugins`

**Breaking changes in v1.2.0:**
- Agent namespace: `codex:codex-rescue` → `cowork:codex-rescue`
- Slash commands: `/codex:*` → `/cowork:*` (e.g. `/codex:rescue` → `/cowork:rescue`, `/codex:setup` → `/cowork:setup`)
- The `/codex:review` command is renamed to `/cowork:code-review` (to avoid collision with the cowork review protocol at `/cowork:review`)

## How the agents collaborate

Claude (Opus) orchestrates. It holds the full conversation, drives the protocol rounds, and mediates the synthesis. It has continuous memory across all rounds.

Codex (GPT-5) is the independent voice. Each early-round invocation is a fresh thread so its critiques aren't anchored to its own prior work. Later rounds resume the thread so it carries its reasoning into sign-off, implementation, and review.

Sonnet is invisible plumbing — the thin wrapper agent (`cowork:codex-rescue`) that gathers project context and forwards prompts to the Codex CLI. You never interact with it directly.

```
You → Claude (Opus) → Sonnet wrapper → Codex CLI → GPT-5
                                                      ↓
You ← Claude (Opus) ← ─────────────────────── response
```

## Why this exists

The default Claude + Codex integration is one architect, one reviewer. That's fine for code review, but it wastes Codex's ability to *think differently* about a problem.

These plugins make both models architects. They draft independently, critique each other honestly, converge on one plan, and share implementation responsibility. The result is better than either model alone — not because two is more than one, but because genuine disagreement followed by forced convergence catches blind spots that a single model's self-review never will.

## Why fork Codex and bundle it?

The upstream OpenAI plugin sandboxes Codex (no network, restricted filesystem) and is also broken on Windows (spawn ENOENT). Both needed fixing for cowork to work reliably.

In v1.1.0 the fix was a separate `codex@cc-plugins` plugin — a "drop-in replacement" for the upstream. That turned out to be impossible: Claude Code's plugin CLI treats plugin name as primary key, so `codex@cc-plugins` and `codex@openai-codex` couldn't coexist and the CLI kept resolving to upstream.

**In v1.2.0 the forked runtime is merged directly into the `cowork` plugin.** The plugin name is `cowork` (no collision), the Codex runtime lives inside it as `scripts/codex-companion.mjs` + `scripts/lib/*.mjs`, and the agent is `cowork:codex-rescue`. The upstream `codex@openai-codex` plugin can coexist if you want it — the two plugins no longer share a name.

## License

MIT. See [LICENSE](LICENSE).

The bundled Codex runtime is forked from [openai/codex-plugin-cc](https://github.com/openai/codex-plugin-cc) (v1.0.3, Apache-2.0). See [NOTICE](plugins/cowork/NOTICE) for upstream attribution. The original Codex plugin CHANGELOG is preserved at `plugins/cowork/CHANGELOG-codex.md`.
