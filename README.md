# geocine-pi

Personal pi plugin set for local-first agent work: a cheap local model owns
the loop; stronger models are consulted on evidence, in a context-capped
jail; every decision is logged as future fine-tuning data.

## Extensions

| File | What it does | Invocation |
| --- | --- | --- |
| `extensions/bash-repair.ts` | Strips ANSI/progress-bar noise from bash output, then prepends a compact `[failfmt]` block (failing check, file:line, observed vs expected) for go/cargo/pytest/node failures. | Automatic on every failed bash call. |
| `extensions/watchdog.ts` | Set-and-forget failure detection: deterministic counters (loops, fail streaks) + optional low-context LLM verdict from a second small model; injects "Located" hints; suggests consulting after repeat detections. | Automatic. `/watchdog on\|off\|status`. |
| `extensions/advisor.ts` | The `consult` tool (LLM-invoked) + `/consult` command: stages a minimal snapshot (context firewall), optional local guardrail pre-screen, runs the consultant in the staged dir / docker jail / in place, returns one advisory note. | `consult` tool, `/consult`, `/consultants`. |
| `extensions/rescue.ts` | Captures manual rescue episodes: when you `/model`-switch from a local provider to a frontier model, it records the local model's failing tail, the rescuer's tool trajectory, touched files and its final summary as a `rescue` record. `/distill` turns the latest episode (this session or from the log) into a draft lesson under `~/.pi/agent/rescue-lessons/` (never auto-loaded — promote by hand). | Automatic on model switch. `/distill`. |
| `extensions/geocine-menu.ts` | The hub: one menu for the whole plugin set — consultants (inspect, set default, prefill a consult), approval mode, watchdog/rescue toggles (persisted to geocine.json, applied immediately), distill latest rescue, consult-log stats, lesson drafts (preview / paste-to-promote), and editing geocine.json in place with JSON validation. | `/geocine`, or jump: `/geocine consultants\|approval\|watchdog\|rescue\|distill\|log\|lessons\|config`. |
| `extensions/qwen-harness.ts` | Pi + llama.cpp pairing for Qwen models: recovers Qwen-native XML tool calls (coder/VL/invoke formats), remaps scaffold tool names/args to pi's tools, relaxes tool schemas that crash llama.cpp's grammar converter, and drives thinking (`enable_thinking`, budget tokens, Qwen3-report sampling defaults). | Automatic for models whose id contains "qwen". `/qwen off\|low\|…\|max\|auto`. |
| `extensions/baseten-limits.ts` | Client-side RPM/TPM gate for the Baseten provider (Basic tier: 15 RPM / 100k TPM) — delays requests instead of erroring. Tune via `BASETEN_RPM` / `BASETEN_TPM` env vars. | Automatic on Baseten models. |

## Install

```bash
pi install /path/to/geocine-pi     # global (settings.json), live-editable
# or per project:
pi install -l /path/to/geocine-pi
```

Then create the config:

```bash
cp geocine.example.json ~/.pi/agent/geocine.json   # and edit
```

`/reload` in a running session picks up edits to these extension files.

## Configuration (`~/.pi/agent/geocine.json`)

- `consultants.<name>` — provider/model plus policy:
  - `role`: one line saying what this consultant is the right **rescuer**
    for ("hard debugging", "planning", "content strict models falsely
    refuse"). The roster with roles is embedded in the consult tool
    description, so the local model proposes a rescuer by role; the
    approval prompt shows the proposal.
  - `jail`: `"staged"` (temp dir with only staged files — default),
    `"docker"` (staged + container), `"none"` (in place, read-only tools;
    for free/local consultants).
  - `prescreen`: run the local guardrail false-positive screen first
    (for strict cloud models).
  - `autoApprove`: skip the approval prompt for this consultant.
- `defaultConsultant` — used when no name is given.
- `approval.consultTool` — permission gate for **LLM-invoked** `consult`
  tool calls (`"ask"` default / `"auto"`). The prompt shows the proposed
  rescuer and offers: use it / **choose a different rescuer** / deny /
  always-allow-this-consultant / auto-approve-all; "always" answers persist
  to geocine.json. A denial tells the model to keep working itself and is
  logged as a `"user_no"` request — a free "should not have consulted"
  training label. User-typed `/consult` and headless runs never prompt.
  Routing provenance is logged per request (`proposedConsultant` vs final
  `consultant`, `chosenBy: model|default|user_override|auto`), so user
  overrides accumulate as "wrong rescuer for this kind of problem" labels.
- `prescreen.consultant` — which local consultant does the screening.
- `watchdog.baseUrl` — optional second small-model endpoint for tier-1
  verdicts. **Never the main single-slot llama.cpp server** (KV-cache
  eviction).

## Decision log

Append-only JSONL under `~/.pi/agent/consult-log/YYYY-MM.jsonl`, one
correlation id (`cid`) per consultation/incident:

`consult_request` → `staging` (manifest, bytes) → `prescreen` (risk,
triggers) → `consult_result` (advice, refusal flag, files-read utilization,
usage) plus `watchdog` verdict records with their decision-time digests.

These records are the rung-1 instrumentation of the local-worker offload
ladder: guardrail-predictor labels come free from actual refusals,
briefing→answer pairs are distillation data, watchdog digests→outcomes train
the escalation policy, and staging-manifest vs files-read measures context
curation. A future `/consult-export` turns them into QLoRA datasets.

## Rescue episodes → training data

The highest-value pairs come from *manual* rescues: the local model grinds,
you switch to a frontier model, it fixes the thing. Two capture paths:

- **Live**: `extensions/rescue.ts` watches `model_select`. Switching away
  from a `rescue.localProviders` provider starts an episode; switching back
  (or session end) writes a `rescue` record: failure digest (the local
  model's last ~30 entries), the rescuer's tool events, files touched, its
  final summary. `/distill` then drafts a one-lesson markdown file to
  `~/.pi/agent/rescue-lessons/` — status `draft`, never injected into any
  prompt. Promoting a lesson into `AGENTS.md` or a skill is your call.
- **Retroactive**: pi session JSONL stamps every `model_change` and every
  assistant message with its model, so history is minable offline:

  ```bash
  node scripts/mine-rescues.mjs                    # scans ~/.pi/agent/sessions
  node scripts/mine-rescues.mjs --out rescues.jsonl --min-actions 2
  ```

  Each output line is `{failure_context, rescue_trajectory, fromModel,
  toModel, filesTouched, …}` — SFT-ready raw material: train the local model
  on (failure context → rescuer trajectory), and the switch events
  themselves label the escalation policy ("should have consulted here").

## Docker jail (optional)

```bash
docker build -t geocine-consult docker
```

Only needed for `jail: "docker"` consultants. `jail: "staged"` already gives
the token firewall (the consultant's cwd contains only staged files) without
a container.

Auth note: `staged`/`none` consultants run as pi processes on the host and
inherit `~/.pi/agent/auth.json` — OAuth providers (xai, openai-codex, …)
just work. The docker jail does NOT get host auth; use `envKeys` to forward
API keys, or prefer `staged` for OAuth consultants.

## Testing quickly

```bash
# 1. Load check — session starts, /geocine opens the hub menu:
pi
/geocine
/consultants
/watchdog status

# 2. bash-repair: ask the model to run a failing pytest/go test; the tool
#    result should start with a [failfmt] block.

# 3. consult (lenient, free): /consult @local-big what does this repo do?

# 4. consult tool end-to-end: ask the main model to
#    "consult about <question> staging only <file>" and watch the status bar.
```
