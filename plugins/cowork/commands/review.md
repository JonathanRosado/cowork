---
description: Claude implements, then both agents review — quick implementation with two-agent post-review
---

Claude implements the requested changes, then both agents (Claude and Codex) independently review the result and synthesize findings into a consolidated assessment with optional fixes.

**Task from the user:** $ARGUMENTS

Unlike `/cowork`, there are no design rounds — Claude implements directly, then the two-agent review protocol runs on the result. This is the "fast path": Claude's judgment on implementation, both agents' judgment on review. Use this when the task is clear enough that design rounds would be overhead but you still want rigorous post-implementation review.

---

## Session context (before Round 1)

Codex cannot see the conversation history. To give it shared context, maintain a session context file at `.cowork-session.md` in the working directory.

**Step 1 — Read:** Check if `.cowork-session.md` exists. If it does, read it.

**Step 2 — Update:** Review the existing content (if any) against your current conversation context. For each existing entry, check whether it has been superseded by a newer decision — if so, update or remove it. Then append any NEW items under the appropriate category. The file must reflect the current state of decisions, not a chronological log. If the file doesn't exist, create it from scratch.

Use this exact structure:

```markdown
## Hard constraints
- [things Codex MUST follow — user directives, non-negotiable requirements]

## Decisions made
- [what's been decided and should not be relitigated]

## Rejected approaches
- [what was considered, and why it was dropped]
```

Each entry should be one line, specific and self-contained. Write entries so they make sense without surrounding context.

**Step 3 — Include:** Include the full content of `.cowork-session.md` at the top of the Codex prompt in Round 1, inside a fenced block:

```
**Session context (from prior conversation):**
[full contents of .cowork-session.md]
```

If the conversation has no meaningful prior context and no `.cowork-session.md` exists, skip this step.

---

## Implementation phase (before Round 1)

Implement the task described in `$ARGUMENTS` using standard Claude Code workflow: write code, run commands, verify behavior. Work through it methodically. No design rounds, no Codex involvement — this is Claude's direct implementation.

When implementation is complete, gather a **change manifest** for the review:

1. Run `git status --short` and `git diff` to capture what changed.
2. Build a compact summary: files modified, nature of each change.

This manifest anchors the review rounds that follow.

---

## Thread management

| Round | Thread | Why |
|---|---|---|
| Round 1 (parallel review) | **Fresh** | Independence — no prior Codex context exists |
| Round 4 (re-review after fixes) | **Resume** (`--resume`) | Codex remembers what it flagged and can verify fixes |

If `--resume` fails, fall back to a fresh call with the full context pasted in. Log the fallback.

---

## Round 1 — Parallel review (fresh Codex thread)

Announce: "Both agents reviewing independently."

Simultaneously, in a single message with two tool calls:

1. **Your review (Review A):** Review the changes against (a) the session context, (b) the user's review focus, (c) general best practices. Structure as: what looks correct, what raises concerns (name files and line ranges), code smells, potential issues. ~200–300 words. Be honest — the goal is quality, not defending the implementation.

2. **Codex's review (Review B):** Spawn `codex:codex-rescue` with a fresh thread. Include in the prompt:
   - The session context (from `.cowork-session.md`) in the standard fenced block
   - The change manifest (files changed, key diffs — keep it compact, under 500 lines)
   - The user's review focus
   - "Review this implementation independently. You have full access to the project filesystem — read any files you need for additional context. List what's correct, what raises concerns, code smells, and potential issues. Be specific — name files, line numbers, and concrete problems. Ground every claim in actual code you read. ~200–300 words."
   - **This is a fresh thread.**

Neither review should see the other.

## Round 2 — Synthesis

Read both reviews. Produce:

- **Agreements** — findings both agents independently confirmed (high confidence).
- **Disagreements** — where reviews conflict, with your assessment of which is correct (cite evidence).
- **Issues found** — consolidated list ordered by severity. Each: file, description, which agent(s) flagged it.
- **Verdict** — one of:
  - `clean` — no substantive issues. Present summary and stop.
  - `issues found` — proceed to Round 3 fix cycle.
  - `needs user input` — issues require user decision (design tradeoffs). Present and stop.

## Round 3 — Fix cycle (only if verdict is "issues found")

Fix the flagged issues using standard Claude Code workflow. Keep fixes tightly scoped to flagged issues — no unrelated refactors or cleanup.

## Round 4 — Re-review (only if Round 3 applied fixes)

Spawn `codex:codex-rescue` with `--resume`. Include the list of issues raised and how each was fixed. Ask: "The following issues were raised and fixed: [list]. Do you agree the implementation is now sound, or do you have remaining objections? Be specific."

- If Codex signs off: present the settlement summary.
- If Codex still objects: note the unresolved objection, present both the implementation and the objection to the user, and let the user decide. Do not loop further.

---

## Settlement summary

Present at the end regardless of path:

- What was reviewed (files, scope)
- Key findings from both agents
- What was fixed (if anything)
- Remaining caveats
- Whether both agents agree the implementation is sound

---

## Rules

- Keep inter-round narration to one sentence per round.
- If Codex is unavailable or errors out, tell the user immediately and provide Claude's review alone with a note that it was not cross-verified.
- Do not shortcut Round 1 even if the changes look trivially correct — the value is independent assessment.
- Evaluate honestly. Do not defend implementation choices — assess them.
- One fix cycle maximum. If Round 4 raises new issues, present them to the user rather than looping.
- If `--resume` fails for the Round 4 Codex call, fall back to a fresh call with the full context pasted in. Log the fallback.
