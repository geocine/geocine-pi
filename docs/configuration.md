# Configuration

One file rules everything: `~/.pi/agent/geocine.json` (global), optionally
overridden by `.pi/geocine.json` in a project (shallow merge, consultants
merged by name). Start from
[`geocine.example.json`](../geocine.example.json):

```bash
cp geocine.example.json ~/.pi/agent/geocine.json   # and edit
```

Extensions re-read the config on every event, so edits apply immediately —
no reload. `/geocine config` edits it in place with JSON validation.

## Consultants

`consultants.<name>` — provider/model plus policy:

- `role` — one line saying what this consultant is the right **rescuer**
  for ("hard debugging", "planning", "content strict models falsely
  refuse"). The roster with roles is embedded in the consult tool
  description, so the local model proposes a rescuer by role; the approval
  prompt shows the proposal.
- `jail` — `"staged"` (temp dir with only staged files — default),
  `"docker"` (staged + container, see [docker-jail.md](docker-jail.md)),
  `"none"` (in place, read-only tools; for free/local consultants).
- `prescreen` — run the local guardrail false-positive screen first
  (for strict cloud models).
- `autoApprove` — skip the approval prompt for this consultant.
- `thinking` — pi `--thinking` value for the consultant run.
- `notes` — extra briefing context (persona/emphasis).
- `envKeys` — env var names forwarded into a docker jail (API-key
  providers only; OAuth needs no keys outside docker).
- `defaultConsultant` — used when no name is given.

Auth: consultants run as pi child processes on the host and inherit
`~/.pi/agent/auth.json`, so OAuth providers (xai, openai-codex, ...) work
with no extra config. The docker jail is the exception — see
[docker-jail.md](docker-jail.md).

### Invoking a consultation

- The **model** calls the `consult` tool with a question plus the minimal
  files to stage; its live thinking/answer streams into the tool display.
- **You** type `/consult [@consultant] [+file[:a-b] …] <question>` — `+`
  tokens stage files (e.g. `/consult @frontier +docs/outline.md is this
  order right?`); progress streams in the footer status bar.
- A staged-jail consultation with **no files** runs as pure Q&A: the
  consultant gets no workspace and no read tools, is told so explicitly,
  and is asked to name the paths it would need for a confident answer.

## Approval gate

`approval.consultTool` — permission gate for **LLM-invoked** `consult` tool
calls (`"ask"` default / `"auto"`). The prompt shows the proposed rescuer
and offers: use it / **choose a different rescuer** / deny /
always-allow-this-consultant / auto-approve-all; "always" answers persist to
geocine.json. A denial tells the model to keep working itself and is logged
as a `"user_no"` request — a free "should not have consulted" training
label. User-typed `/consult` and headless runs never prompt.

Routing provenance is logged per request (`proposedConsultant` vs final
`consultant`, `chosenBy: model|default|user_override|auto`), so user
overrides accumulate as "wrong rescuer for this kind of problem" labels.

## Watchdog

- `watchdog.enabled` — master switch (tier 0 is free).
- `watchdog.baseUrl` / `model` / `apiKeyEnv` — optional second small-model
  endpoint for tier-1 verdicts. **Never the main single-slot llama.cpp
  server** (a side request evicts the main KV cache).
- `watchdog.sendHints`, `hintCooldownTurns`, `loopThreshold`,
  `failStreakThreshold` — hint pacing and tier-0 sensitivity.

## Context keeper

- `context.mode` — compaction style: `"arc"` (deterministic digest, no
  model call, default), `"checkpoint"` (LLM-written structured checkpoint),
  or `"off"` (pi default).
- `context.recall` — the transcript search tool. Default on.
- `context.compactAtTokens` — compact early at this many tokens while a
  local provider is active (pi's own threshold, contextWindow − reserve, is
  minutes of prompt re-ingest too late on local hardware). Unset = off.
- `context.idleCompactMinutes` — also compact after N idle minutes once the
  context is past half the threshold. Unset = off.
- `context.pruner` — ingestion-time trimming of oversized bash/powershell
  outputs (cache-neutral; the full output stays searchable via recall).
  Default on.
- `context.summarizer` — checkpoint mode only: consultant whose model
  writes the checkpoint (default: the session's own model, which reuses the
  warm KV cache).
- `context.maxTokens`, `prunerThresholdChars`, `prunerHeadChars`,
  `prunerTailChars` — budgets.
- `qwen.auto` / `qwen.level` — persisted `/qwen` thinking state (written
  automatically by the command; survives restarts and `/reload`).

See [context.md](context.md) for the design and the research behind it.

## Rescue capture

- `rescue.enabled` — capture manual local-to-frontier switch episodes.
- `rescue.localProviders` — providers considered "local"; switching away
  from one starts an episode.
- `rescue.distillConsultant` — who drafts `/distill` lessons (default:
  the prescreen consultant).

See [training-data.md](training-data.md) for what the episodes are for.

## Pre-screen

- `prescreen.consultant` — which local consultant screens staged content
  for guardrail false-positive risk before strict cloud consultants see it.
- `prescreen.maxBytes` — staged bytes shown to the screener.

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
