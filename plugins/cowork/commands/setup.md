---
description: Check whether the local Codex CLI is ready and optionally toggle the stop-time review gate or inspect model routing
argument-hint: '[--enable-review-gate|--disable-review-gate|--show-routing]'
allowed-tools: Bash(node:*), Bash(npm:*), AskUserQuestion
---

Run:

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/codex-companion.mjs" setup --json $ARGUMENTS
```

If the result says Codex is unavailable and npm is available:
- Use `AskUserQuestion` exactly once to ask whether Claude should install Codex now.
- Put the install option first and suffix it with `(Recommended)`.
- Use these two options:
  - `Install Codex (Recommended)`
  - `Skip for now`
- If the user chooses install, run:

```bash
npm install -g @openai/codex
```

- Then rerun:

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/codex-companion.mjs" setup --json $ARGUMENTS
```

If Codex is already installed or npm is unavailable:
- Do not ask about installation.

If `$ARGUMENTS` contains `--show-routing`, additionally run:

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/codex-companion.mjs" config routing get
```

and present both the setup output and the routing table.

Output rules:
- Present the final setup output to the user.
- If installation was skipped, present the original setup output.
- If Codex is installed but not authenticated, preserve the guidance to run `!codex login`.
- To change model routing per phase, point the user to `config routing set <phase> <model> <effort>` (e.g. `node "${CLAUDE_PLUGIN_ROOT}/scripts/codex-companion.mjs" config routing set P4 gpt-5.4-pro xhigh`). Do not run this interactively — only surface the command.
