# geocine-pi

Local-first plugin set for [pi](https://github.com/earendil-works/pi): a
cheap local model owns the loop; stronger models are consulted on evidence,
behind a user approval gate, inside a context-capped jail; and every
decision — approvals, denials, routing overrides, refusals, manual rescues —
is logged as future fine-tuning data.

![architecture](assets/architecture.svg)

## Extensions

| Extension | What it does | Invocation |
| --- | --- | --- |
| `advisor` | `consult` tool: stages a minimal snapshot, optional guardrail pre-screen, runs a consultant, returns one advisory note. Rescuer proposed by role; user approves, overrides, or denies. | `consult` tool, `/consult`, `/consultants` |
| `ask-user` | `ask_user` tool: lets the model ask you one question (pick-one options or free text) via pi's own dialogs — so it never improvises file/plugin-based prompting mechanisms from its training data. | `ask_user` tool |
| `watchdog` | Loop/fail-streak detection (deterministic counters + optional mini-LLM verdict); injects "Located" hints. | Automatic. `/watchdog` |
| `rescue` | Captures manual local-to-frontier `/model` switches as training episodes; drafts lessons from them. | Automatic. `/distill` |
| `context-keeper` | Long-session context management: early + idle compaction for local providers, deterministic ARC-style compaction digest (no model call; LLM checkpoint optional), model-written `note`s pinned verbatim across compactions with a pre-cut reminder, ingestion-time pruning of big shell outputs, and `recall` transcript search (exact + BM25 fallback + full entry read-back) so compaction is never lossy. | Automatic. `recall`, `note` tools |
| `worked-timer` | Codex-style run timing: live elapsed on the "Working..." line, "Worked for Xm Ys · turns · tool calls" summary per run (approval-dialog wait time excluded). | Automatic |
| `geocine-menu` | One hub menu for everything above. | `/geocine` |
| `bash-repair` | Strips terminal noise; prepends compact failure summaries (go/cargo/pytest/node). | Automatic |
| `models/` | Per-model-family harness registry, one file per family. Qwen: tool-call recovery, llama.cpp schema fixes, thinking budgets. Grok and OpenAI: declared slots, no behaviors yet. | Automatic. `/harness` |
| `baseten-limits` | Client-side RPM/TPM pacing + server `429 retry_after` handling for Baseten. | Automatic |

## Install

```bash
pi install /path/to/geocine-pi          # global, live-editable
cp geocine.example.json ~/.pi/agent/geocine.json   # then edit consultants
```

## Quick start

```bash
pi
/geocine                 # hub: consultants, approval mode, toggles, logs, lessons
/consult @frontier +docs/outline.md is this topic order right?   # + tokens stage files
```

When the local model gets stuck it calls the `consult` tool itself,
proposing a rescuer by role — you approve, pick another, or deny. Every
outcome lands in the consult-log.

## Docs

- [Configuration](docs/configuration.md) — consultants, roles, jails, approval gate, watchdog, testing
- [Local Qwen server](docs/local-qwen.md) — recommended `llama-server` launch flags for Qwen3.8-27B and why they matter
- [Context management](docs/context.md) — compaction modes, ingestion pruner, recall tool, and the research behind them
- [Training data](docs/training-data.md) — the decision log, rescue episodes, mining history, lessons
- [Docker jail](docs/docker-jail.md) — hardened consultant isolation and auth notes
