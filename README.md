<h1 align="center">cowork</h1>

<p align="center">
  <strong>A protocol for pairing Opus with Codex.</strong><br/>
  Three slash commands. No hooks. No background jobs. No implicit behavior. The protocol runs when you invoke it, and only then.
</p>

<p align="center">
  <img src="https://img.shields.io/github/license/JonathanRosado/cowork?color=blue" alt="License: MIT">
  <img src="https://img.shields.io/badge/Claude%20Code-plugin-orange" alt="Claude Code plugin">
  <img src="https://img.shields.io/badge/Codex-gpt--5.4%20xhigh-black" alt="Codex gpt-5.4 xhigh">
  <img src="https://img.shields.io/badge/sandbox-disabled-red" alt="Sandbox disabled">
</p>

---

## Why a protocol, not a hook plugin

Prior iterations of cowork tried to make Codex help Claude invisibly — hooks firing on every prompt, every edit, every commit. That design produced noise, silent failures, background token burn, and reviews of conversations that had nothing to review.

This version reverses that. Cowork does exactly nothing until you type a command. When you do, it executes a well-defined collaboration between **Opus** (you, the local Claude Code agent) and **Codex** (`gpt-5.4` at `xhigh` effort, run unsandboxed with full filesystem + network access through a bundled forked runtime). Phases block. Agents critique each other. The output is a synthesized answer or a reviewed implementation, not a soup of background signals.

---

## The three commands

### `/cowork` — full five-stage protocol

Use for non-trivial engineering work where you want an adversarial pair of eyes. Each phase blocks on the previous one.

1. **Parallel research.** 4 Codex research agents (each on a different facet of the problem) fire in parallel with 1 Opus research subagent. Blocking; all 5 return before phase 2.
2. **Dual plans + mutual critique + master plan.** You and Codex each produce a low-level plan one step above code. You critique Codex's plan; Codex critiques yours. You synthesize a master plan addressing both critiques — silent drops are forbidden. **User sign-off gate** before implementation.
3. **Opus implements** the master plan.
4. **Codex adversarially reviews** the implementation against the master plan with full project filesystem access. Output is graded findings + a single-line `SIGNOFF` or `BLOCKED: …` verdict.
5. **Opus fixes + re-review loop.** Address findings, re-run review. Hard cap of 5 review iterations — if Codex is still returning BLOCKED after five rounds, the protocol escalates to you.

Latency honesty: a full run takes minutes, not seconds. The protocol is for work where that cost is worth paying.

### `/cowork:question` — 10-agent research, synthesized

Ask a question. Cowork fires **8 Codex research agents** (each on a different angle of the question) plus **2 Opus research subagents** (first-principles + contrarian/steel-man) in parallel. All 10 block to completion. Opus then digests the findings into a synthesized response with a direct answer, named disagreements between sources, supporting evidence per source, and open questions the research couldn't close.

Use for questions where breadth actually matters — design decisions, "what do systems like ours usually do here," "is approach X defensible." Skip for lookups and status checks.

### `/cowork:rescue` — forward a stuck turn to Codex

When Opus is stuck, looping, or just wrong, `/cowork:rescue <request>` packages compact project context (cwd, git status, recent files, relevant code) and forwards the rescue request to Codex with full filesystem + network access and no sandbox. Codex answers; Opus returns the answer verbatim without self-commenting. Think of it as "ask the other agent" as an explicit operator action.

---

## Requirements

- **Node.js ≥ 20.**
- **Claude Code** with plugin support.
- **OpenAI Codex CLI** installed and authenticated on your machine — cowork bundles a forked runtime but uses the upstream Codex CLI for actual inference. Run `/cowork:setup` after install to verify.

---

## Install

```
/plugin marketplace add https://github.com/JonathanRosado/cowork.git
/plugin install cowork@cowork
```

After install, run `/cowork:setup` once to confirm Codex CLI is ready.

---

## Runtime notes

- **No hooks.** `hooks/hooks.json` is absent. Installing cowork does not change any behavior of your Claude Code session until you invoke a command.
- **Sandbox disabled by default.** The bundled Codex runtime runs with `sandbox: "danger-full-access"`. This is intentional — research and review agents need to read your project and, for rescue, reach out to the network. If that model is wrong for your environment, this plugin is not for you.
- **Attribution.** Every Codex dispatch embeds `<cowork-meta owner="cowork" flow="..." role="..." />` in the prompt so the cowork ledger tracks spend per phase / per command.
- **Model + effort are fixed.** Every Codex dispatch in the protocol runs at `gpt-5.4 xhigh`. This is deliberate; the whole protocol assumes strong Codex output. Downgrading defeats the point.

---

## Auxiliary commands (for managing Codex dispatches)

| Command | Purpose |
|---|---|
| `/cowork:setup` | Verify local Codex CLI installation, authentication, and model routing. |
| `/cowork:status [job-id]` | List currently-running or recently-completed Codex dispatches. |
| `/cowork:cancel <job-id>` | Cancel a running Codex dispatch. |
| `/cowork:config [key] [value]` | Read or set cowork runtime config keys. |

---

## What cowork is NOT

- Not a hook plugin. Nothing fires implicitly.
- Not a review queue. There is no findings queue, no accept/reject workflow, no pre-commit gate.
- Not a workflow engine. There is no phase-graph state machine. The protocol is a sequence of prompts Opus follows.
- Not a Claude Code replacement. Cowork extends Claude Code by adding disciplined access to a second vendor — nothing else.

---

## License

[MIT](LICENSE) © 2026 Jonathan Rosado.

Bundled Codex runtime under Apache 2.0 from OpenAI — see `plugins/cowork/NOTICE`.
