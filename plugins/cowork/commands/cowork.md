---
description: Co-work with Codex — independent drafts, mutual critique, provenance-routed implementation, settlement
---

The user wants a solution co-designed and co-implemented by you (Claude) and Codex (GPT-5 via the `codex:codex-rescue` agent).

**Problem statement from the user:** $ARGUMENTS

Before starting Round 1, announce to the user: "The protocol will determine the primary implementation agent based on which agent's thinking dominates the converged plan. **To override this, say `claude implements` or `codex implements` at any point before or during the design rounds.** If no override is given, the protocol's provenance routing decides."

Check whether the user's problem statement already includes an implementation agent override (e.g. "codex implements" or "claude implements" anywhere in $ARGUMENTS). If so, note it and use that override regardless of provenance routing.

This command has two modes depending on whether plan mode is already active. **Do not call `EnterPlanMode` yourself** — that decision belongs to the user.

---

## Mode detection

Check whether plan mode is currently active.

- **Plan mode active** → follow the **Design protocol** (Rounds 1–4) and stop. Output a converged plan. No implementation.
- **Plan mode not active** → follow the **Design protocol** (Rounds 1–4), then **implement** the converged plan (routed to the primary architect), then follow the **Settlement protocol** (Rounds 5–7) where both agents review the implementation.

---

## Context preamble (before Round 1)

Before starting the design rounds, generate a short context summary for Codex. Since Codex cannot see the conversation history, this summary ensures it has awareness of key decisions and constraints already established.

**To avoid wasting tokens on summarization, spawn a Haiku agent** (set `model: "haiku"` on the Agent tool) with the following prompt: "Summarize the key decisions, constraints, and context from this conversation that are relevant to the following problem: [problem statement]. Include only decisions already made, constraints the user has established, and relevant prior conclusions. 3–5 bullets, under 150 words. Do not include recommendations — only established facts and decisions."

Store the returned summary as the **context preamble**. Include it at the top of every Codex prompt for the remainder of this protocol, formatted as:

```
**Prior context (established in this session):**
[summary bullets]
```

If the conversation has no meaningful prior context (e.g. the user's first message is the `/cowork` invocation), skip this step.

---

## Thread management

Codex invocations use a hybrid threading model to balance independence (early rounds) with continuity (later rounds):

| Round | Thread | Why |
|---|---|---|
| Round 1 (draft) | **Fresh** | Blind drafting — independence preserved |
| Round 2 (critique) | **Fresh** (`--fresh`) | Unanchored critique — epistemic diversity preserved |
| Round 4 (sign-off) | **Resume Round 2** (`--resume`) | Codex remembers its critique when evaluating the synthesis |
| Implementation | **Resume** (`--resume`) | Codex carries its reasoning chain into implementation |
| Settlement (5–7) | **Resume** (`--resume`) | Codex reviews with awareness of all prior rounds |

If `--resume` fails at any point (thread expired, state lost), fall back to a fresh call with the full context pasted in. Log the fallback so the user knows continuity was lost.

---

## Design protocol (Rounds 1–4)

Announce each round to the user in one short sentence before starting it.

### Round 1 — Independent drafts (parallel, fresh threads)

Simultaneously, in a single message with two tool calls:

1. Draft your own approach (Approach A) — do this as your own thinking, do not write it to a file. Keep it to ~200–400 words covering: goal, high-level approach, key design decisions, risks.
2. Spawn the `codex:codex-rescue` agent with a self-contained prompt asking Codex to draft an independent approach (Approach B) to the same problem. Give Codex the problem statement verbatim plus any relevant repo context you have gathered. Explicitly tell Codex: "Do not implement. Return a ~200–400 word proposal covering goal, approach, key design decisions, and risks. You are one of two agents co-working on this; a second proposal will be generated independently." **This is a fresh thread.**

Neither draft should see the other in this round.

### Round 2 — Mutual critique (fresh Codex thread)

In a single message with one tool call (you critique B yourself; Codex critiques A via the agent):

1. Write your critique of Approach B: what it gets right, what it misses, what constraints it overlooks, what you would borrow from it. Be specific and fair — the goal is convergence, not winning.
2. Spawn `codex:codex-rescue` with `--fresh` and Approach A pasted in full, asking Codex to critique it against Approach B with the same framing: strengths, gaps, borrowings, specific objections. Tell Codex this is round 2 of a co-work protocol. **This must be a fresh thread** to prevent anchoring to Round 1.

### Round 3 — Synthesis + provenance tagging

You merge everything into a single unified proposal. Structure it as:

- **Converged approach** — the single plan, written as if it were the only one.
- **Provenance** — short bullets: "From A (Claude): …", "From B (Codex): …", "New (synthesis): …".
- **Resolved disagreements** — where A and B conflicted, which side won and why.
- **Primary architect** — based on provenance, tag which agent's thinking dominated the converged plan. State: `Primary architect: Claude` or `Primary architect: Codex`. This determines who implements in bypass mode.
- **Open questions** — anything neither proposal settled.

Keep the synthesis tight — it is a plan, not an essay.

### Round 4 — Sign-off (resume Codex thread)

Spawn `codex:codex-rescue` with `--resume` and the full synthesis. Ask: "Do you agree with this converged plan, or do you have substantive objections? If objections, be specific — state what to change and why. If you agree, say so plainly." Tell Codex this is the sign-off round and its thread is being resumed so it has continuity from its Round 2 critique.

- If Codex signs off: present the synthesis to the user as the final converged plan, with a one-line note that Codex signed off.
- If Codex pushes back substantively: incorporate the pushback into a revised synthesis, note the revision in a short "revision after sign-off" section, and present the revised plan to the user. Do not loop again — one revision is the cap.

### After Round 4

Present the converged plan to the user. Include:
- A short "how we got here" trail (2–4 bullets)
- The **primary architect** tag and which agent will implement (or the user's override, if one was given)

- **If plan mode is active:** stop here. The user reviews the plan and decides when to exit plan mode.
- **If plan mode is not active:** proceed directly to the Implementation phase. Use the user's override if one was given during the design rounds; otherwise use the tagged primary architect. Do not wait for user confirmation — implementation flows automatically after design converges. The user can still hand off mid-implementation by saying `switch to claude`, `switch to codex`, or `I'll take over`.

---

## Implementation phase (bypass mode only)

### Agent routing

The **primary architect** from Round 3 implements by default. The user can override at any time:

- `claude implements` → Claude implements (standard Claude Code workflow).
- `codex implements` → forward the converged plan to `codex:codex-rescue` with `--resume --write`: "Implement this converged plan. You have full context from prior rounds. Work through it methodically — write code, run tests, verify behavior."
- `switch to claude` / `switch to codex` / `I'll take over` → mid-implementation handoff. Acknowledge in one sentence and continue with the new agent (or stop and let the user work).
- No override → use the tagged primary architect.

### Implementation execution

Whichever agent implements, follow normal practices: write code, run tests, verify behavior. Work through the plan methodically.

When implementation is complete, move to the Settlement protocol.

---

## Settlement protocol (Rounds 5–7, bypass mode only)

The implementation is done. Now both agents review it and converge on whether it meets the converged plan.

### Round 5 — Implementation review (parallel, resume Codex thread)

In a single message with two tool calls:

1. Review your own implementation against the converged plan. List: (a) what was implemented as planned, (b) any deviations and why, (c) anything you would change on a second pass. Keep it to ~200 words. Be honest — the goal is quality, not defending your work.
2. Spawn `codex:codex-rescue` with `--resume` and a description of what was implemented (files changed, key decisions). Ask Codex: "Review this implementation against the converged plan. You have context from all prior rounds. List what's correct, what deviates, and any code smells or issues. Be specific — name files and concerns. ~200–300 words."

### Round 6 — Settle

Read both reviews. If both agree the implementation is sound:
- Present a short "settlement summary" to the user: what was built, what both agents agree on, any caveats.
- Stop. The work is done.

If either review raises substantive issues:
- Fix the issues (using whichever agent is currently implementing, or switching per the user's preference).
- Spawn `codex:codex-rescue` with `--resume` and the fixes applied, asking: "The following issues were raised and fixed: [list]. Do you agree the implementation now meets the plan, or do you have remaining objections?" This is Round 7.

### Round 7 — Final settlement (only if Round 6 raised issues)

- If Codex signs off: present the settlement summary to the user.
- If Codex still objects: note the unresolved objection, present both the implementation and the objection to the user, and let the user decide. Do not loop further.

---

## Rules

- **Never call `EnterPlanMode` or `ExitPlanMode`.** The user controls plan mode.
- **Respect the user's agent override at all times.** If the user specifies who implements, that overrides the provenance tag immediately. If the user says to switch mid-implementation, switch immediately.
- Keep inter-round narration to one sentence per round so the user can follow without drowning in process.
- If Codex is unavailable or errors out, tell the user immediately and ask whether to proceed with Claude-only or abort.
- Do not shortcut rounds even if the two proposals look similar in Round 1 — the critique round often surfaces non-obvious disagreements.
- During the Settlement protocol, do not defend implementation choices — evaluate them honestly. The goal is a correct result, not a defended one.
- If `--resume` fails for any Codex call, fall back to a fresh call with the full context pasted in. Log the fallback.
