---
description: Research-heavy Q&A — 8 parallel Codex research agents + 2 Opus research subagents, then Opus digests the findings and presents a synthesized answer. Use when you want a question answered with real breadth, not a one-shot guess.
argument-hint: '<question>'
allowed-tools: Bash(node:*), Task, Read, Glob, Grep
---

The user has invoked `/cowork:question`. The question is in `$ARGUMENTS`.

You are Opus. Run a **two-phase** research protocol. Both phases are blocking — do not present an answer until every dispatched agent has returned.

---

## Phase 1 — 10 parallel research dispatches (8 Codex + 2 Opus), blocking

Dispatch, in a single message with all ten tool calls at once:

### Eight Codex research agents (`gpt-5.4`, `xhigh`)

Each is a Bash call to `codex-companion task` in blocking mode. Split the research across eight angles that genuinely partition the question's surface — do not duplicate. Starter taxonomy; adapt:

1. **Canonical solutions / textbook answers.** What does the literature already say?
2. **Prior art / reference implementations.** What do production systems actually do?
3. **Edge cases and failure modes.** Where do naive answers break?
4. **Tradeoffs and decision axes.** What are the dimensions to choose along?
5. **Performance, scale, cost characteristics.** What breaks at scale? What's cheap vs. expensive?
6. **Security, safety, correctness invariants.** What can go wrong quietly?
7. **Observability and testing.** How is the answer verified at runtime and in CI?
8. **Alternatives and their tradeoffs.** What would you pick instead and why?

Example dispatch:

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/codex-companion.mjs" task \
  --model gpt-5.4 --effort xhigh -- \
  "$(cat <<'PROMPT'
<cowork-meta owner="cowork" flow="cowork-question" role="research" />
<task>Research angle 1/8: canonical solutions to the following question. Cite concrete sources (docs URLs, RFCs, published papers, reference implementations). Return ≤600 words.

Question: <USER QUESTION>
</task>
<grounding_rules>Every claim cites a source. No vibes.</grounding_rules>
PROMPT
)"
```

### Two Opus research subagents (Task tool, `subagent_type="general-purpose"`)

Fire **two** Task tool calls in the same parallel batch. Each approaches the question from an Opus-native angle distinct from the Codex eight — for example:

- **Subagent A:** first-principles analysis. "Forget prior art; reason about the question from primitives. What's the minimum structure that could answer it? Where does that diverge from the canonical solutions?"
- **Subagent B:** contrarian / steel-man-the-unpopular-view. "What's a respected-but-minority position on this question? What does it get right? Why did the mainstream answer win (if it did)?"

Both Opus subagents return written analyses of ≤600 words, with sources where claimed.

### Wait for all ten

Block until all ten dispatches return. Do not begin phase 2 with partial results.

---

## Phase 2 — Opus digests and presents

Consolidate the ten findings. Your output to the user has four parts, in this order:

1. **Direct answer.** One or two paragraphs synthesizing the ten sources into the most defensible answer to the question. Take a position where the evidence supports one; acknowledge when it's genuinely contested.
2. **Key disagreements.** Where the ten sources conflicted — who said what, and which side the weight of evidence favors. If there's a real controversy, name it.
3. **Supporting evidence.** Three to six bullet points, each citing a specific source from the research (Codex angle N or Opus subagent A/B) with the concrete claim it contributed.
4. **What's still unknown.** Open questions the research couldn't close. Don't hide them.

Keep the whole response under 800 words unless the question is genuinely enormous. Breadth goes into the research phase; depth goes into the synthesis.

---

## Rules

- **Blocking.** Do not present a partial answer while dispatches are still running.
- **Ten dispatches.** Eight Codex + two Opus subagents. If you fire fewer, you have not run this protocol.
- **Parallel.** All ten dispatches in one message, single parallel batch. Serial dispatch wastes the protocol's whole advantage.
- **Attribution.** Every Codex prompt carries `<cowork-meta owner="cowork" flow="cowork-question" role="research" />`.
- **Model + effort.** Codex dispatches use `--model gpt-5.4 --effort xhigh`. No downgrade.
- **No fallback to single-agent.** If Codex is unavailable, stop and tell the user — this protocol is the answer, not Opus's own first guess.
