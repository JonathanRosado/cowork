---
description: Read, set, or reset cowork config keys that control the 4 hooks.
argument-hint: '[get|set|reset] [<key> [<value>]] [--json]'
allowed-tools: Bash(node:*)
---

Run:

```bash
COWORK_CONFIG_ARGS="$ARGUMENTS"
COWORK_CONFIG_FLAGS=()
for word in $COWORK_CONFIG_ARGS; do
  case "$word" in
    get|set|reset) COWORK_CONFIG_FLAGS+=("$word") ;;
    --json) COWORK_CONFIG_FLAGS+=("$word") ;;
    watch_enabled|watch_review_trivial|watch_inflight_cap) COWORK_CONFIG_FLAGS+=("$word") ;;
    pre_commit_gate|pre_commit_strict) COWORK_CONFIG_FLAGS+=("$word") ;;
    prompt_research|prompt_research_angles|prompt_research_model|prompt_research_effort) COWORK_CONFIG_FLAGS+=("$word") ;;
    gpt-5.4|gpt-5.4-mini|gpt-5.3-codex|gpt-5.3-codex-spark|gpt-5.2) COWORK_CONFIG_FLAGS+=("$word") ;;
    minimal|low|medium|high|xhigh) COWORK_CONFIG_FLAGS+=("$word") ;;
    session_start_findings|findings_max_age_days) COWORK_CONFIG_FLAGS+=("$word") ;;
    true|false) COWORK_CONFIG_FLAGS+=("$word") ;;
    [0-9]) COWORK_CONFIG_FLAGS+=("$word") ;;
    [0-9][0-9]) COWORK_CONFIG_FLAGS+=("$word") ;;
    [0-9][0-9][0-9]) COWORK_CONFIG_FLAGS+=("$word") ;;
    *) ;;
  esac
done
# No subcommand → show all values (default, scriptable, zero tokens).
if [ ${#COWORK_CONFIG_FLAGS[@]} -eq 0 ]; then
  COWORK_CONFIG_FLAGS=(get)
fi
# Bare `--json` alone → `get --json` (natural intent; CLI rejects `config --json`).
if [ ${#COWORK_CONFIG_FLAGS[@]} -eq 1 ] && [ "${COWORK_CONFIG_FLAGS[0]}" = "--json" ]; then
  COWORK_CONFIG_FLAGS=(get --json)
fi
node "${CLAUDE_PLUGIN_ROOT}/scripts/codex-companion.mjs" config "${COWORK_CONFIG_FLAGS[@]}"
```

## Usage

- `/cowork:config` — print all 11 config values (merged with built-in defaults).
- `/cowork:config get <key>` — print one key's value; annotated `(default)` if not explicitly set.
- `/cowork:config set <key> <value>` — write an override.
- `/cowork:config reset <key>` — remove the override; reader-side default takes over.
- `/cowork:config --json` — JSON output suitable for piping into `jq`.

The whole surface is zero-token — the bash block runs directly, no Claude turn involved. A widget-style UI would require `AskUserQuestion`, which costs a turn per dispatch. Plugins don't have access to Claude Code's native in-process widget rendering (the thing `/chrome` and `/model` use).

## Config keys

| Key | Default | Effect |
|---|---|---|
| `watch_enabled` | `true` | Post-edit Codex adversarial-review hook |
| `watch_review_trivial` | `false` | If `true`, review every edit regardless of size |
| `watch_inflight_cap` | `2` | Max concurrent background Codex reviews |
| `pre_commit_gate` | `true` | Pre-commit hook that checks findings queue |
| `pre_commit_strict` | `true` | Block `git commit` on BLOCKER/HIGH; `false` = warn only |
| `prompt_research` | `true` | Auto-fire research on design-intent prompts |
| `prompt_research_angles` | `3` | Number of parallel research dispatches (1-5) |
| `prompt_research_model` | `gpt-5.4` | Model for research dispatches |
| `prompt_research_effort` | `xhigh` | Reasoning effort for research dispatches (minimal/low/medium/high/xhigh) |
| `session_start_findings` | `true` | Surface pending findings at session start |
| `findings_max_age_days` | `7` | Ignore findings older than this in session-start surface |

## Examples

```
/cowork:config                              # show all values
/cowork:config get                          # same
/cowork:config get pre_commit_gate          # show one key + (default) annotation
/cowork:config set pre_commit_strict false  # warn-only gate
/cowork:config set prompt_research false    # turn off auto-research
/cowork:config set prompt_research_angles 5 # wider research fan-out
/cowork:config reset watch_enabled          # drop the override; fall back to default
/cowork:config --json                       # JSON dump
```

## Where config lives

The plugin's workspace-scoped state file. Config is keyed per workspace, so different projects can have different settings.

Plugin-level disable: uninstall cowork or remove `~/.claude/plugins/cowork/`. Hooks go away with the plugin.
