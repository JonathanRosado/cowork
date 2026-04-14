---
description: Ask both Claude and Codex the same question — each researches independently, then synthesize
---

The user has a question they want answered by both you (Claude) and Codex (GPT-5 via the `cowork:codex-rescue` agent) independently, then synthesized into one answer.

**Question from the user:** $ARGUMENTS

Unlike `/cowork`, this is not a design-and-implement protocol. It is a research protocol: both agents investigate the question using whatever tools they have, then you synthesize the two answers into one.

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

If the conversation has no meaningful prior context (e.g. the user's first message is the `/cowork:question` invocation and no `.cowork-session.md` exists), skip this step.

---

## Round 1 — Independent research (parallel)

Simultaneously, in a single message with two tool calls:

1. **Your answer (Answer A):** Research the question yourself. Use your tools — read project files, grep code, run commands, fetch URLs, whatever the question requires. Arrive at your own conclusion. Keep it to ~200–400 words. Be specific and cite evidence (file paths, command output, URLs).

2. **Codex's answer (Answer B):** Spawn `cowork:codex-rescue` with the question verbatim. Tell Codex:
   - "Answer this question independently. You have full access to the project filesystem and the network."
   - "Read any project files you need. Run CLI commands, curl endpoints, check documentation — use your tools to arrive at an evidence-based answer."
   - "Do not guess when you can verify. If the answer is in a file, read it. If it requires a network call, make it."
   - "Keep your answer to ~200–400 words. Cite evidence: file paths, command output, URLs."
   - **This is a fresh thread.**

Neither answer should see the other in this round.

## Round 2 — Synthesis

Read both answers. Produce a single synthesized response:

- **Synthesized answer** — the unified answer, written as one coherent response.
- **Where they agreed** — the claims both agents independently confirmed.
- **Where they disagreed** — any conflicts, with your assessment of which is correct and why (cite the evidence each agent provided).
- **Evidence quality** — note which claims are backed by direct evidence (file contents, command output, API responses) vs which are reasoning or inference.

If the two answers are substantially identical, say so briefly and present the shared answer without padding.

## Round 3 — Codex verification (optional, only if disagreements exist)

If Round 2 found substantive disagreements, spawn `cowork:codex-rescue` with `--resume` and ask Codex to verify the specific disputed claims. Paste Claude's evidence and ask Codex to confirm or refute with its own evidence.

If no disagreements, skip this round.

---

## Rules

- **Both agents must do their own research.** Do not pre-digest the answer for Codex. Give it the raw question and let it investigate independently.
- **Codex should use the network.** If the question could benefit from checking an API, fetching a URL, running a CLI tool, or querying a service, tell Codex to do so. Codex has full network access.
- **Codex should use the filesystem.** If the answer is in a project file, Codex should read it itself rather than receiving it pre-pasted.
- Keep the synthesis concise. If both agents agree, one paragraph is enough.
- If Codex is unavailable, tell the user and provide Claude's answer alone with a note that it was not cross-verified.
