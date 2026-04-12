# cc-plugins

[![MIT License](https://img.shields.io/badge/license-MIT-green.svg)](LICENSE)
[![Claude Code](https://img.shields.io/badge/Claude%20Code-plugins-orange)](https://claude.com/claude-code)

Personal Claude Code plugin collection. One install, multiple plugins.

## Plugins

### codex (forked)

Drop-in replacement for [openai/codex-plugin-cc](https://github.com/openai/codex-plugin-cc). Two changes from upstream:

1. **No sandbox.** All Codex runs use `danger-full-access` — full filesystem read/write and full network. Codex can run `curl`, CLI tools, access APIs, and read/write anywhere. No bubblewrap, no network isolation, no permission errors.

2. **Project-aware.** Before forwarding a task to Codex, the agent reads the project file tree, `CLAUDE.md`, and `CHANGELOG.md`, then includes that context in the prompt. Codex sees the project structure without needing it pasted in manually.

Same commands, same skills, same interface as the original. Replace the OpenAI plugin with this one and everything works the same — minus the sandbox friction.

### co-design

Claude and Codex co-design solutions through a structured protocol. Two modes:

- **Plan mode active:** 4-round design protocol (draft → critique → synthesize → sign-off). Outputs a converged plan.
- **Plan mode not active:** same 4 rounds, then implements the plan, then a 3-round settlement protocol where both agents review the result.

See the [co-design README](https://github.com/JonathanRosado/co-design-plugin) for the full protocol diagram.

## Install

First, remove the upstream OpenAI Codex plugin if installed:

```
/plugins
# find and uninstall the openai-codex entry
```

Then install this collection:

```
/install-plugin JonathanRosado/cc-plugins
```

This installs both `codex` and `co-design`. Codex commands (`/codex:rescue`, `/codex:review`, etc.) work unchanged. `/co-design` works unchanged.

## Requirements

- [Claude Code](https://claude.com/claude-code)
- [Codex CLI](https://github.com/openai/codex) installed and authenticated (`codex login`)

## Why fork Codex?

The upstream Codex plugin runs tasks in a sandboxed environment that blocks network access and restricts filesystem writes. This is safe but limiting:

- Codex can't call APIs (cloud CLIs, `curl`, `gh`)
- Codex can't read files outside the sandbox mount
- Codex can't verify claims that require network access
- Cryptic failures when the sandbox blocks a legitimate operation

If you're running Claude Code on your own machine and you trust what Codex does, the sandbox adds friction without value. This fork removes it.

## License

MIT. See [LICENSE](LICENSE).

The `codex` plugin is forked from [openai/codex-plugin-cc](https://github.com/openai/codex-plugin-cc) (v1.0.3, Apache-2.0). See `plugins/codex/LICENSE` and `plugins/codex/NOTICE` for upstream attribution.
