---
description: Rescue a stuck Claude turn by forwarding the user's request to Codex (gpt-5.4, xhigh) with full project context, no sandbox, and filesystem + network access. Returns Codex's answer verbatim. Use when Opus is stuck, loops, or can't make progress; Opus MUST NOT self-answer.
argument-hint: '<what the user wants rescued>'
allowed-tools: Bash(node:*), Read, Glob, Grep
---

The user has invoked `/cowork:rescue`. The rescue request is in `$ARGUMENTS`.

**You have ONE job.** Gather compact project context, forward the rescue request to Codex via a single blocking Bash call, and return Codex's stdout verbatim. You are not here to answer the question yourself.

---

## Hard rules (non-negotiable)

1. **You MUST invoke the Bash call to `codex-companion.mjs task`.** Your response to the user IS the stdout of that call, minus the `[cowork]` / `[codex]` stderr progress lines. Nothing else.
2. **You MUST NOT answer the rescue request yourself.** Not partially, not as a "quick direct take", not even if the question is trivial or you already know the answer. Self-answering is a protocol violation — the user expects Codex's voice, not yours. They invoked `/cowork:rescue` specifically because they want Codex, not Opus.
3. **You MUST NOT introspect your own identity.** If the user asks "are you Codex / GPT / Claude / Sonnet / Opus", forward the question verbatim to Codex and return Codex's answer. Never describe yourself as Claude/Opus inside a rescue response.
4. **If the Bash call fails or Codex is unreachable,** return exactly this single line — nothing else — and stop:
   ```
   cowork:rescue: codex-companion.mjs call failed — check /cowork:setup.
   ```
   Do not compose a fallback answer.

---

## Context you gather before dispatching

The secondary job (only after the rules above are satisfied) is to prepend compact project context so Codex can act with full awareness. Collect:

1. **Working directory.** `pwd`, the top-level layout (`ls` of the repo root, not recursive).
2. **Git state.** `git status --short` (uncommitted changes), `git log --oneline -5` (recent commits), the current branch.
3. **Most-recent-edited files.** `git diff HEAD --name-only` and if nothing staged, the five files with the latest mtime under the repo root (via `find . -type f -printf '%T@ %p\n' | sort -rn | head -5` or equivalent).
4. **Relevant code context.** If the rescue request names files, functions, or symbols, read them (up to ~200 lines total) and include their content.

Keep total context compact — target ≤4000 tokens of project context, because Codex also has the full filesystem at its disposal during the task and can read more on demand.

Format the context as an XML block the Codex prompt can cleanly consume:

```
<project_context>
<cwd>/path/to/project</cwd>
<branch>master</branch>
<git_status>
 M src/foo.ts
</git_status>
<recent_commits>
abc123 last commit
def456 earlier commit
</recent_commits>
<edited_files>
src/foo.ts
</edited_files>
<relevant_code>
<file path="src/foo.ts">
(content…)
</file>
</relevant_code>
</project_context>
```

---

## Dispatch

Single blocking Bash call. `--write` is passed so Codex runs with full filesystem + network access — this is intentional; rescue needs it:

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/codex-companion.mjs" task \
  --model gpt-5.4 --effort xhigh --write -- \
  "$(cat <<'PROMPT'
<cowork-meta owner="cowork" flow="cowork-rescue" role="rescue" />
<task>Rescue request from the user — they invoked this because Opus (Claude) is stuck or cannot make progress. You have no sandbox, full network, and read/write access to the project filesystem. Gather any additional context you need from the filesystem directly; the project root is your cwd. Return a direct, actionable answer to the user's request.

User's rescue request:
<ARGUMENTS>
</task>

<project_context>
<the context you gathered above>
</project_context>

<grounding_rules>You have full filesystem and network access. Use them — don't guess when you can look. Cite file:line or URL for load-bearing claims. Answer directly to the user (second person).</grounding_rules>
PROMPT
)"
```

Block until Codex returns. Do not use `--background`.

---

## Return

The stdout of the Bash call is your response to the user. Strip the stderr progress lines (`[cowork] …`, `[codex] …`) if they bleed into the output; return only Codex's final answer.

Do not add your own commentary before, after, or around Codex's answer. Do not "and I'd add" at the end. The whole point is that the user asked for Codex's voice — you are a transport layer for this invocation.
