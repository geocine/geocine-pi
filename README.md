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
| `watchdog` | Loop/fail-streak detection (deterministic counters + optional mini-LLM verdict); injects "Located" hints. | Automatic. `/watchdog` |
| `rescue` | Captures manual local-to-frontier `/model` switches as training episodes; drafts lessons from them. | Automatic. `/distill` |
| `context-keeper` | Long-session context management: deterministic pruning of old oversized tool results, `recall` transcript search (compaction is never lossy), and structured prefix-cache-aligned checkpoint compaction. | Automatic. `recall` tool |
| `geocine-menu` | One hub menu for everything above. | `/geocine` |
| `bash-repair` | Strips terminal noise; prepends compact failure summaries (go/cargo/pytest/node). | Automatic |
| `qwen-harness` | pi + llama.cpp pairing for Qwen: tool-call recovery, schema fixes, thinking budgets. | Automatic. `/qwen` |
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
/consult @local-big what does this repo do?
```

When the local model gets stuck it calls the `consult` tool itself,
proposing a rescuer by role — you approve, pick another, or deny. Every
outcome lands in the consult-log.

## Docs

- [Configuration](docs/configuration.md) — consultants, roles, jails, approval gate, watchdog, testing
- [Context management](docs/context.md) — pruner, recall tool, checkpoint compaction, and the research behind them
- [Training data](docs/training-data.md) — the decision log, rescue episodes, mining history, lessons
- [Docker jail](docs/docker-jail.md) — hardened consultant isolation and auth notes
