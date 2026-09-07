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

## Session modes

A mode is a session profile: some sessions are plain coding, others handle
content (reverse engineering, decompiled binaries, security material) that
strict cloud models falsely refuse — those need a different consultant set
and a different prescreen posture.

`modes.<name>`:

- `description` — one line shown in menus.
- `consultants` — names selectable as rescuers while this mode is active
  (applies to both the LLM-invoked `consult` tool and `/consult`; anything
  else returns an error naming the available set). Unset = all.
- `defaultConsultant` — default rescuer for this mode.
- `prescreen` — policy override: `"skip"` (never screen — plain coding),
  `"force"` (screen every staged consult, whatever the per-consultant flag
  says — sensitive sessions), or `"consultant"` (default: the per-consultant
  flag decides). Jail-`"none"` consultants never stage files, so they are
  never screened regardless.

Which mode is active, in priority order:

1. Session override — `/geocine mode`, "This session only".
2. Project pin — `"mode": "sensitive"` in the project's `.pi/geocine.json`
   (set-and-forget for an RE folder).
3. Global default — `"mode": "coding"` in `~/.pi/agent/geocine.json`.

Example (from `geocine.example.json`): `coding` allows frontier + local-big
with prescreen skipped; `sensitive` defaults to the abliterated consultant
and force-prescreens anything that still goes to a strict cloud model. The
active mode is logged on every consult request as a routing feature.

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
- `context.recall` — the transcript search tool (exact regex primary, BM25
  fallback on zero matches, full entry read-back via `entry`/`offsetChars`).
  Default on.
- `context.notes` — the `note` tool; notes are pinned verbatim into every
  compaction digest. Default on.
- `context.reminderTokens` — pre-compaction reminder lead: within this many
  tokens of `compactAtTokens`, the model is told once to pin load-bearing
  facts before the cut. Default 8000; 0 disables.
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
- `qwen.auto` / `qwen.level` — persisted Qwen thinking state, set via
  `/harness auto` and `/harness <level>` (written automatically by the
  command; survives restarts and `/reload`).

See [context.md](context.md) for the design and the research behind it.

## Model harnesses

- `harness.aliases` — transparent tool aliasing (default true). Each model
  family's harness advertises the tool names and parameter schemas the model
  was RL-trained on (qwen-code dialect for Qwen, grok-build dialect for
  Grok, codex `exec_command` for OpenAI) while pi's registry and the stored
  transcript stay canonical. Outbound requests rename tool definitions, the
  system prompt tool list, and replayed history; finalized tool calls are
  mapped back before execution. Set to `false` to send pi's canonical names
  unchanged. Model-owned tools (e.g. `apply_patch` for OpenAI) are only
  advertised while their harness is active regardless of this setting.

The harness layer also implements trained tools pi lacks, so every family's
core RL toolset resolves to something real:

- `todo` — session plan list, persisted across restarts and compactions.
  Advertised as `todo_write` to Qwen and Grok (Grok's merge-by-id semantics
  supported) and as `update_plan` to OpenAI models. Canonical `todo` for
  everyone else.
- `web_fetch` / `web_search` — URL fetch (HTML stripped to readable text)
  and DuckDuckGo search with domain filtering. Trained into qwen-code and
  grok-build, so they are owned by those harnesses and hidden from other
  models (codex web access is provider-hosted).
- `ask_user_question` — Qwen and Grok's multi-question envelope, mapped
  onto the single-question `ask_user` tool (first question is asked).
- `view_image` — codex's attach-image-by-path tool, mapped onto pi `read`
  for OpenAI models (codex models read text via `exec_command`, as trained).

## Web providers

- `web.provider` — what serves the canonical `web_fetch` / `web_search`
  tools: `"auto"` (default), `"tinyfish"`, or `"builtin"`. The tool names
  and schemas the models see never change; only the backend does.
  - `tinyfish` — [TinyFish](https://tinyfish.ai) search + fetch APIs.
    Native domain include/exclude filtering, and fetch renders the page
    server-side to Markdown (much better than HTML stripping on JS-heavy
    pages). Needs an API key.
  - `builtin` — DuckDuckGo HTML scrape + plain fetch with dependency-free
    HTML-to-text. No key, always available.
  - `auto` picks the first available provider (tinyfish when its key is
    present) and, if a keyed provider errors mid-call, retries that call
    with builtin and says so in the result. A **pinned** provider's errors
    surface instead — you asked for it, you should see it fail.
- `web.tinyfishApiKey` — literal key or a `"$VAR_NAME"` environment
  reference; the `TINYFISH_API_KEY` environment variable also works.
  Keys: <https://agent.tinyfish.ai/api-keys>. API keys are redacted from
  error messages before they can reach the transcript.

Adding a provider later: drop a file in `lib/web-providers/` exporting a
`WebProvider` (id, `available()`, `search()`, `fetch()`) and append it to
`PROVIDERS` in `lib/web-providers/index.ts` — keyed providers go before
`builtin` so auto prefers them the moment their key appears. Selection,
fallback, budget caps, and the tool schemas need no changes.
`scripts/smoke-web.mjs` exercises selection, pinning errors, and live
builtin calls (`node --experimental-strip-types scripts/smoke-web.mjs`);
with a TinyFish key in the environment it runs live through TinyFish.

## PDF reader

- `pdf.maxChars` — output cap for one `read_pdf` call (default 24000).
  The tool fills whole pages until the budget runs out, then names the
  omitted pages so the model requests exactly what it needs next call
  instead of flooding a local context with a 200-page document.
- `pdf.maxSearchMatches` — matching lines returned by a `search` call
  (default 40).

Extraction is native ([@firecrawl/pdf-inspector](https://github.com/firecrawl/pdf-inspector),
Rust via napi, ~10–50ms to classify, ~150ms to extract a text PDF; parsing
runs on the libuv pool, not the event loop). Scanned/image pages carry no
text layer and are flagged with their machine-readable reason instead of
extracted — the OCR pipeline (external PDFium + ONNX Runtime libraries) is
deliberately not wired in. `scripts/smoke-pdf.mjs` and
`scripts/smoke-pdf-budget.mjs` exercise the tool end-to-end
(`node --experimental-strip-types scripts/smoke-pdf.mjs`).

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
