---
description: Co-design a solution with Codex — independent drafts, mutual critique, synthesis, sign-off
---

The user wants a solution co-designed by you (Claude) and Codex (GPT-5 via the `codex:codex-rescue` agent).

**Problem statement from the user:** $ARGUMENTS

This command has two modes depending on whether plan mode is already active. **Do not call `EnterPlanMode` yourself** — that decision belongs to the user.

---

## Mode detection

Check whether plan mode is currently active.

- **Plan mode active** → follow the **Design protocol** (Rounds 1–4) and stop. Output a converged plan. No implementation.
- **Plan mode not active** → follow the **Design protocol** (Rounds 1–4), then **implement** the converged plan, then follow the **Settlement protocol** (Rounds 5–7) where both agents review the implementation and converge on whether it's done.

---

## Design protocol (Rounds 1–4)

Announce each round to the user in one short sentence before starting it.

### Round 1 — Independent drafts (parallel)

Simultaneously, in a single message with two tool calls:

1. Draft your own approach (Approach A) — do this as your own thinking, do not write it to a file. Keep it to ~200–400 words covering: goal, high-level approach, key design decisions, risks.
2. Spawn the `codex:codex-rescue` agent with a self-contained prompt asking Codex to draft an independent approach (Approach B) to the same problem. Give Codex the problem statement verbatim plus any relevant repo context you have gathered. Explicitly tell Codex: "Do not implement. Return a ~200–400 word proposal covering goal, approach, key design decisions, and risks. You are one of two agents co-designing this; a second proposal will be generated independently."

Neither draft should see the other in this round.

### Round 2 — Mutual critique

In a single message with one tool call (you critique B yourself; Codex critiques A via the agent):

1. Write your critique of Approach B: what it gets right, what it misses, what constraints it overlooks, what you would borrow from it. Be specific and fair — the goal is convergence, not winning.
2. Spawn `codex:codex-rescue` again with Approach A pasted in full, asking Codex to critique it against Approach B with the same framing: strengths, gaps, borrowings, specific objections. Tell Codex this is round 2 of a 4-round co-design protocol.

### Round 3 — Synthesis

You merge everything into a single unified proposal. Structure it as:

- **Converged approach** — the single plan, written as if it were the only one.
- **Provenance** — short bullets: "From A: …", "From B: …", "New (synthesis): …".
- **Resolved disagreements** — where A and B conflicted, which side won and why.
- **Open questions** — anything neither proposal settled.

Keep the synthesis tight — it is a plan, not an essay.

### Round 4 — Sign-off

Spawn `codex:codex-rescue` one final time with the full synthesis. Ask: "Do you agree with this converged plan, or do you have substantive objections? If objections, be specific — state what to change and why. If you agree, say so plainly." Tell Codex this is the final sign-off round.

- If Codex signs off: present the synthesis to the user as the final converged plan, with a one-line note that Codex signed off.
- If Codex pushes back substantively: incorporate the pushback into a revised synthesis, note the revision in a short "revision after sign-off" section, and present the revised plan to the user. Do not loop again — one revision is the cap.

### After Round 4

Present the converged plan to the user. Include a short "how we got here" trail (2–4 bullets).

- **If plan mode is active:** stop here. The user reviews the plan and decides when to exit plan mode and implement.
- **If plan mode is not active:** tell the user you are proceeding to implement the converged plan, then move to the Implementation phase below.

---

## Implementation phase (bypass mode only)

Implement the converged plan from Rounds 1–4. Follow normal Claude Code implementation practices: write code, run tests, verify behavior. Work through the plan methodically.

When implementation is complete, move to the Settlement protocol.

---

## Settlement protocol (Rounds 5–7, bypass mode only)

The implementation is done. Now both agents review it and converge on whether it meets the converged plan.

### Round 5 — Implementation review (parallel)

In a single message with two tool calls:

1. Review your own implementation against the converged plan. List: (a) what was implemented as planned, (b) any deviations and why, (c) anything you would change on a second pass. Keep it to ~200 words. Be honest — the goal is quality, not defending your work.
2. Spawn `codex:codex-rescue` with the converged plan and a description of what was implemented (files changed, key decisions made during implementation). Ask Codex: "Review this implementation against the plan. List what's correct, what deviates, and any code smells or issues. Be specific — name files and concerns. ~200–300 words."

### Round 6 — Settle

Read both reviews. If both agree the implementation is sound:
- Present a short "settlement summary" to the user: what was built, what both agents agree on, any caveats.
- Stop. The work is done.

If either review raises substantive issues:
- Fix the issues.
- Spawn `codex:codex-rescue` one final time with the fixes applied, asking: "The following issues were raised and fixed: [list]. Do you agree the implementation now meets the plan, or do you have remaining objections?" This is Round 7.

### Round 7 — Final settlement (only if Round 6 raised issues)

- If Codex signs off: present the settlement summary to the user.
- If Codex still objects: note the unresolved objection, present both the implementation and the objection to the user, and let the user decide. Do not loop further.

---

## Rules

- **Never call `EnterPlanMode` or `ExitPlanMode`.** The user controls plan mode.
- Keep inter-round narration to one sentence per round so the user can follow without drowning in process.
- If Codex is unavailable or errors out, tell the user immediately and ask whether to proceed with Claude-only design or abort.
- Do not shortcut rounds even if the two proposals look similar in Round 1 — the critique round often surfaces non-obvious disagreements.
- During the Settlement protocol, do not defend implementation choices — evaluate them honestly. The goal is a correct result, not a defended one.
