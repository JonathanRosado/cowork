# cowork

[![MIT License](https://img.shields.io/badge/license-MIT-green.svg)](LICENSE)
[![Claude Code](https://img.shields.io/badge/Claude%20Code-plugins-orange)](https://claude.com/claude-code)

**Make Claude and Codex actually work together.** Not one plans and the other reviews - both think, both build, both hold each other accountable.

A single self-contained Claude Code plugin that turns Claude (Opus) and Codex (GPT-5) into collaborating agents with shared project context, full tool access, and structured protocols for design, implementation, and review. The forked unrestricted Codex runtime is bundled directly into the plugin, so install is just `cowork@cc-plugins`.

## What's in the box

### `/cowork:cowork` - design + implement + settle

Two AI architects argue about your problem, converge on one plan, then one of them builds it while the other reviews.

```text
/cowork:cowork add rate limiting to our public API
```

```text
Rounds 1-2    Claude drafts.     Codex drafts.     Both critique.    (independent)
                    \                /
Round 3              Claude synthesizes -> tags primary architect
                              |
Round 4              Codex signs off (with memory of its critique)
                              |
              Primary architect implements (Claude or Codex)
                              |
Rounds 5-7    Both review the implementation -> settle or fix
```

**Key features:**
- **Provenance routing** - whichever agent's thinking dominated the plan implements it, because it has the deeper mental model of why the solution is shaped that way.
- **Hybrid threading** - early rounds are independent for epistemic diversity; later rounds resume the same Codex thread for continuity.
- **User override** - reply `claude implements` or `codex implements` after the plan to route manually. Say `switch to claude` or `switch to codex` mid-implementation to hand off.
- **Plan mode aware** - if you are already in plan mode, it stops after Round 4 with the converged plan. Otherwise it continues through implementation and settlement.

### `/cowork:question` - parallel research + synthesis

Both agents independently research the same question using their full toolsets, then Claude synthesizes the answers.

```text
/cowork:question does the Nebius provider support attaching shared filesystems to K8s node groups?
```

- Both agents read files, run commands, and hit APIs independently.
- Claude synthesizes where they agreed, where they disagreed, and how strong the evidence is.
- If disputes remain, Codex verifies the specific claims in a follow-up round.

Good for questions where you want a second opinion backed by independent evidence, not just a second phrasing of the same guess.

### `/cowork:review` - implement then both-agent review

Claude implements, then both Claude and Codex review the implementation in parallel and settle on whether it meets the plan.

### Bundled unrestricted Codex runtime

The `cowork` plugin bundles a forked Codex runtime - the same `codex-companion.mjs` plus app-server broker used by the upstream OpenAI plugin, with these behavior changes:

1. **No sandbox.** Full filesystem and network access. Codex can run your CLI tools, call APIs, `curl` endpoints, and read project files directly.
2. **Project context handoff on rescue-path tasks.** The `cowork:codex-rescue` agent gathers project structure plus `CLAUDE.md` and `CHANGELOG.md` when present before it forwards work to Codex.

Compatibility note: the bundled runtime includes the Windows spawn handling needed to launch the Codex CLI reliably.

### All commands in one plugin

| Command | Purpose |
|---|---|
| `/cowork:cowork` | Full design -> implement -> settle protocol |
| `/cowork:question` | Parallel research + synthesis |
| `/cowork:review` | Implementation review protocol |
| `/cowork:rescue` | Delegate a rescue task to Codex directly |
| `/cowork:code-review` | Run a direct Codex review against local git state |
| `/cowork:setup` | Check Codex CLI readiness |
| `/cowork:status` | Check status of running Codex tasks |
| `/cowork:cancel` | Cancel a running Codex task |
| `/cowork:result` | Fetch the result of a completed Codex task |
| `/cowork:adversarial-review` | Adversarial code review |

`/cowork:review` and `/cowork:code-review` are distinct. Use `/cowork:review` for the cowork implementation-plus-review protocol, and `/cowork:code-review` for a Codex-only review of local git state.

The agent is `cowork:codex-rescue` and is used internally by `/cowork:cowork` and `/cowork:question`.

## Install

### Prerequisites

- [Claude Code](https://claude.com/claude-code)
- [Codex CLI](https://github.com/openai/codex) installed and authenticated with `codex login`

### Install flow

```text
/plugin marketplace add JonathanRosado/cowork
/plugin install cowork@cc-plugins
/reload-plugins
```

Optional hygiene: if you do not want the upstream OpenAI Codex plugin installed alongside `cowork`, remove it with `/plugin uninstall codex@openai-codex`.

### Verify

```text
/cowork:question what project is this?
```

Codex should read your project files and answer without manual context pasting.

## Migration from v1.x

If you used the older split layout, uninstall the old plugins, install `cowork@cc-plugins`, and reload plugins.
v1.2.0 collapses the earlier split packaging into one `cowork` plugin, and the rescue agent plus slash-command namespace now live under `cowork`.
`/cowork:review` and `/cowork:code-review` both remain available as distinct commands in the merged layout.

## How the agents collaborate

Claude (Opus) orchestrates. It holds the full conversation, drives the protocol rounds, and mediates the synthesis. It has continuous memory across all rounds.

Codex (GPT-5) is the independent voice. Each early-round invocation is a fresh thread so its critiques are not anchored to prior work. Later rounds resume the thread so it carries its reasoning into sign-off, implementation, and review.

Sonnet is invisible plumbing - the thin wrapper agent (`cowork:codex-rescue`) that gathers project context and forwards prompts to the Codex CLI. You do not interact with it directly.

```text
You -> Claude (Opus) -> Sonnet wrapper -> Codex CLI -> GPT-5
                                                     |
You <- Claude (Opus) <- ----------------------------- response
```

## Why this exists

The default Claude plus Codex integration is one architect and one reviewer. That is useful for code review, but it leaves a lot of Codex's independent reasoning capacity unused.

This plugin makes both models architects. They draft independently, critique each other honestly, converge on one plan, and share implementation responsibility. The advantage is not just "two models instead of one"; it is forced convergence after real disagreement.

## Why bundle the forked runtime

The upstream OpenAI plugin sandboxes Codex and needed Windows compatibility fixes. Both mattered for cowork's intended workflow.

In v1.2.0 the forked runtime is merged directly into the `cowork` plugin. The plugin name is `cowork`, the Codex runtime lives inside `scripts/codex-companion.mjs` plus `scripts/lib/*.mjs`, and the rescue agent is `cowork:codex-rescue`.

## Troubleshooting

1. If a marketplace update does not show up during install, refresh the local marketplace clone first: `git -C ~/.claude/plugins/marketplaces/cc-plugins pull`, then run `/plugin install cowork@cc-plugins` again and `/reload-plugins`.
2. If `/plugin uninstall` still shows `✓ Enabled`, treat it as a Claude Code display bug and confirm actual state with `/plugin list`.
3. Optional cleanup: if stale upstream Codex state keeps resurfacing, remove `~/.claude/plugins/cache/openai-codex` and reload plugins before reinstalling.

## License

MIT. See [LICENSE](LICENSE).

The bundled Codex runtime is forked from [openai/codex-plugin-cc](https://github.com/openai/codex-plugin-cc) (v1.0.3, Apache-2.0). See [NOTICE](plugins/cowork/NOTICE) for upstream attribution. The original upstream CHANGELOG is preserved at `plugins/cowork/CHANGELOG-codex.md`.
