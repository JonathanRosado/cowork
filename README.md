# cc-plugins

[![MIT License](https://img.shields.io/badge/license-MIT-green.svg)](LICENSE)
[![Claude Code](https://img.shields.io/badge/Claude%20Code-plugins-orange)](https://claude.com/claude-code)

**Make Claude and Codex actually work together.** Not one plans and the other reviews — both think, both build, both hold each other accountable.

A Claude Code plugin collection that turns Claude (Opus) and Codex (GPT-5) into collaborating agents with shared project context, full tool access, and structured protocols for design, implementation, and review.

## What's in the box

### `/cowork` — design + implement + settle

Two AI architects argue about your problem, converge on one plan, then one of them builds it while the other reviews.

```
/cowork add rate limiting to our public API
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

### `codex` — unrestricted drop-in replacement

Forked from [openai/codex-plugin-cc](https://github.com/openai/codex-plugin-cc). Same commands, same interface — two changes:

1. **No sandbox.** Full filesystem and network access. Codex can run your CLI tools, call APIs, `curl` endpoints, read any file. No bubblewrap, no DNS blocks, no cryptic permission errors.

2. **Project-aware.** The agent reads your project structure, `CLAUDE.md`, and `CHANGELOG.md` before every Codex invocation. Codex sees your project context automatically — no manual pasting.

All existing Codex commands work unchanged: `/codex:rescue`, `/codex:review`, `/codex:setup`, etc.

## Install

Remove the upstream OpenAI Codex plugin if installed, then:

```
/install-plugin JonathanRosado/cc-plugins
```

One command installs everything: `cowork`, `cowork:question`, and the unrestricted `codex` replacement.

## Requirements

- [Claude Code](https://claude.com/claude-code)
- [Codex CLI](https://github.com/openai/codex) installed and authenticated (`codex login`)

## How the agents collaborate

Claude (Opus) orchestrates. It holds the full conversation, drives the protocol rounds, and mediates the synthesis. It has continuous memory across all rounds.

Codex (GPT-5) is the independent voice. Each early-round invocation is a fresh thread so its critiques aren't anchored to its own prior work. Later rounds resume the thread so it carries its reasoning into sign-off, implementation, and review.

Sonnet is invisible plumbing — the thin wrapper agent that gathers project context and forwards prompts to the Codex CLI. You never interact with it directly.

```
You → Claude (Opus) → Sonnet wrapper → Codex CLI → GPT-5
                                                      ↓
You ← Claude (Opus) ← ─────────────────────── response
```

## Why this exists

The default Claude + Codex integration is one architect, one reviewer. That's fine for code review, but it wastes Codex's ability to *think differently* about a problem.

These plugins make both models architects. They draft independently, critique each other honestly, converge on one plan, and share implementation responsibility. The result is better than either model alone — not because two is more than one, but because genuine disagreement followed by forced convergence catches blind spots that a single model's self-review never will.

## Why fork Codex?

The upstream plugin sandboxes Codex: no network, restricted filesystem. That means Codex can't call your cloud CLI, can't `curl` an API to verify a claim, can't read files outside the sandbox mount. For the co-work protocol to work — where Codex needs to independently research, verify, and implement — those restrictions had to go.

If you're running on your own machine and you trust what Codex does, the sandbox is friction. This fork removes it.

## License

MIT. See [LICENSE](LICENSE).

The `codex` plugin is forked from [openai/codex-plugin-cc](https://github.com/openai/codex-plugin-cc) (v1.0.3, Apache-2.0). See `plugins/codex/LICENSE` and `plugins/codex/NOTICE` for upstream attribution.
