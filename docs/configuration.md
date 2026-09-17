# Configuration

One file rules everything: `~/.pi/agent/geocine.json` (global), optionally
overridden by `.pi/geocine.json` in a project (shallow merge, models
merged by name). Start from
[`geocine.example.json`](../geocine.example.json):

```bash
cp geocine.example.json ~/.pi/agent/geocine.json   # and edit
```

Extensions re-read the config on every event, so edits apply immediately —
no reload. `/geocine config` edits it in place with JSON validation.

## Models

`models.<name>` — the registry of consultable models: provider/model plus
policy. Key each entry by the model it names (`grok-4.6`, `qwen-27b`), not
by role — classes carry the capability semantics. Register every model you
have, tag it with classes, and let routing auto-decide; there are no
session modes or profiles to manage.

- `role` — one line saying what this model is the right **rescuer**
  for ("hard debugging", "planning", "content strict models falsely
  refuse"). The roster with roles is embedded in the consult tool
  description, so the local worker proposes by role; the approval
  prompt shows the proposal.
- `classes` — capability tags, free-form with a suggested vocabulary:
  `default`, `frontier`, `abliterated`, `cheap`, `fast`, `local`,
  `intelligent`. **Classes are the selection language; the map keys are
  internal ids** (log records and project-config merging) — every surface
  shows `provider/model` plus the class braces instead: the tool roster,
  approval prompts, pickers, status lines, and steer hints all address
  models by class. A class works anywhere a name does: the consult tool's
  `model` param and `/consult @cheap` both resolve to a model carrying it
  (preferring one also classed `default`). The judge's route node sees
  classes too and picks the cheapest model whose capabilities cover the
  need. `default` marks the no-name fallback: move the `default` class to
  change it (`/geocine models` → "Set as default" does exactly that). An
  unclassed model is addressable only as `@<key>` and shows up that way in
  the roster.
- `jail` — `"staged"` (temp dir with only staged files — default),
  `"docker"` (staged + container, see [docker-jail.md](docker-jail.md)),
  `"none"` (in place, read-only tools; for free/local models).
  Staged jails are **enforced**, not just implied by cwd: a jail sentry
  (`lib/jail-sentry.ts`, injected into the child via `pi -e`) intercepts
  every tool call and blocks any path that resolves outside the staging
  dir — absolute paths, `..` traversals, other drives. Deterministic path
  math, no classifier (the jailed toolset is read-only with explicit path
  args, so containment is exact). Blocked attempts are audited and folded
  into the `consult_result` record (`escapeAttempts`, `escapePaths`) and
  flagged in the advisory note, so an escape-happy model is visible
  evidence, never a silent success.
- `prescreen` — run the local guardrail false-positive screen first
  (for strict cloud models).
- `autoApprove` — skip the approval prompt for this model.
- `thinking` — pi `--thinking` value for the consult run.
- `notes` — extra briefing context (persona/emphasis).
- `envKeys` — env var names forwarded into a docker jail (API-key
  providers only; OAuth needs no keys outside docker).

Auth: consulted models run as pi child processes on the host and inherit
`~/.pi/agent/auth.json`, so OAuth providers (xai, openai-codex, ...) work
with no extra config. The docker jail is the exception — see
[docker-jail.md](docker-jail.md).

### Invoking a consultation

- The **worker model** calls the `consult` tool with a question plus the
  minimal files to stage; the consulted model's live thinking/answer
  streams into the tool display. If it names no model, the judge's route
  node assigns one by role and class (`chosenBy: "judge"`); without a judge
  the `default`-classed model applies.
- **You** type `/consult [@model|@class] [+file[:a-b] …] <question>` — `+`
  tokens stage files (e.g. `/consult @frontier +docs/outline.md is this
  order right?`); progress streams in the footer status bar.
- A staged-jail consultation with **no files** runs as pure Q&A: the
  consulted model gets no workspace and no read tools, is told so
  explicitly, and is asked to name the paths it would need for a confident
  answer.

## Approval gate

`approval.consultTool` — permission gate for **LLM-invoked** `consult` tool
calls (`"ask"` default / `"judge"` / `"auto"`). The prompt shows the
proposed model and offers: use it / **choose a different model** / deny /
always-allow-this-model / auto-approve-all; "always" answers persist to
geocine.json. A denial tells the worker to keep working itself and is
logged as a `"user_no"` request — a free "should not have consulted"
training label. User-typed `/consult` and headless runs never prompt.

`"judge"` puts the gate on the decision fabric: the approve node judges
whether the consult is clearly worth running without interrupting you —
substantive question, minimal relevant staging, model classes/cost that
fit the need (cheap/local consults clear easily; frontier-class ones must
look genuinely beyond the local worker). At or above
`approval.approveThreshold` (default 0.85) it runs with a visible
"auto-approved by judge (p=…)" notice and a `"judge_auto"` + `approveP`
record; anything less confident — including no judge, timeout, or rate
cap — falls back to the ask prompt, with the judge's hesitation shown in
the dialog header. The node never auto-denies: deny stays a human choice,
so denial labels stay human labels.

Routing provenance is logged per request (`proposedConsultant` vs final
`consultant` — the record field names are stable even after the registry
rename — plus `chosenBy: model|default|judge|user_override|auto`), so user
overrides accumulate as "wrong model for this kind of problem" labels —
including overrides of the judge's route picks.

## Watchdog

- `watchdog.enabled` — master switch (tier 0 is free).
- `watchdog.judgeEveryTurn` — with a judge configured, every turn with new
  tool activity gets a classifier verdict, not only turns where a counter
  fired. Default **true**: this is what makes drift detectable at all (no
  counter can see it), and System One calls are fast and cheap enough to
  afford the cadence. Judge-only findings (no counter behind them) must
  clear `judge.minConfidence` before a hint is sent; quiet turns confirmed
  quiet produce no log record. Set `false` for verify-only judging.
- `watchdog.baseUrl` / `model` / `apiKeyEnv` — optional second small-model
  endpoint for tier-1 verdicts. **Never the main single-slot llama.cpp
  server** (a side request evicts the main KV cache).
- `watchdog.sendHints`, `hintCooldownTurns`, `loopThreshold`,
  `failStreakThreshold` — hint pacing and tier-0 sensitivity.

## Judge (System One decision fabric)

Fast typed judgments with calibrated probabilities (`lib/judge`), backed by
[TypeSafe's Jev](https://docs.typesafe.ai) — a classifier that answers
noul/choice/score questions in ~100–500 ms instead of generating text.

It is structured as a *decision fabric*: expensive cognition (frontier
consults) and destructive actions sit behind many small typed decisions,
each a "node" over the same contract, each with a deterministic fallback:

```
                 expensive cognition
                        ▲
                        │ only when needed
        ┌───── judge decision fabric ─────┐
   stuck? drift?                    escalate? route?
   done? continue?                  revert? risky?
   regression? scope creep?         needs tests? human?
        └── heuristics as fallback ───────┘
                        │
                deterministic tools
```

Shared plumbing (`lib/judge/index.ts`): every node passes its id, all nodes
share one rate cap (`judge.maxCallsPerMinute`, default 30 — a decision loop
degrades to heuristics instead of hammering the API), and a per-node ledger
(calls, fallback answers, degradations, average latency) is shown by
`/geocine judge`.

Every `judge()` call walks a **degradation ladder**, best answer first:

1. **Jev** (`judge.provider`) — calibrated probabilities, ~100–500 ms.
2. **naive-llm** (`judge.fallback`) — one temperature-0 JSON completion on
   an OpenAI-compatible endpoint (typically the local llama.cpp server, so
   it costs nothing). Deliberately not smart: no retries, no reasoning,
   capped tokens, self-reported probs clamped to 0.85 so this tier never
   out-shouts calibrated sources. It prompts with the same
   `(context, schema)` serialization the trace logs — train/serve parity
   with the future offline head by construction.
3. **Call-site heuristics** — counters, regexes, static defaults; a session
   never breaks because classifiers are missing.

**Decision economics** — the invariant the fabric enforces: *decisions run
on the classifier or deterministic code; LLM tokens are spent on work,
never on deciding.*

- Classifier calls are the cheap currency (a few thousand input tokens per
  call, no text generation) — asked freely, capped by the rate limit. The
  naive-llm fallback tier is local and free; only its latency costs.
- Every answered call is also a training example (`judge.trace`), so the
  cost curve bends toward zero: gather traces → train a local
  constrained-decoding head → repoint `judge.provider` → decisions run
  free on your own hardware.
- LLM-token spend from fabric *actions* is bounded on every path: injected
  hints/steers have cooldowns, gate nudges are capped per task
  (`gate.maxNudgesPerTask`) and suppressed at human decision points, and
  frontier consults sit behind the approval gate.
- Escalation machinery that injects messages — triage steers, mid-task
  escalate suggestions, gate nudges — additionally requires the ACTIVE
  model to be a cheap local provider (`rescue.localProviders`). A frontier
  main model gets verdicts and status lines only: growing an expensive
  model's context to suggest "switch up" is spending tokens on a decision
  already made.
- The two LLM fallbacks that remain are opt-in and last-resort: the
  watchdog's tier-1 endpoint (only if `watchdog.baseUrl` is set, only when
  the judge gave no answer) and the LLM prescreen (only when the judge
  screen gave no answer, typically the free local model).

The fabric nodes today:

- **Watchdog verdicts** — by default on every turn with new tool activity
  (`watchdog.judgeEveryTurn`), which is the only way drift gets caught.
  When a tier-0 counter fires the judge confirms, refines
  (`loop`/`stuck`/`drift`), or overrules it; an "ok" overrule needs
  `judge.minConfidence`, and so does a judge-only accusation with no
  counter behind it (confidence-gated routing both ways). Falls back to
  the tier-1 LLM endpoint, then to tier 0 alone.
- **Task triage & escalation** — difficulty/route judgment on every new
  task, plus a mid-task escalate-now probability. See
  [Triage](#triage-task-routing) below.
- **Outcome gate** — when the agent settles, the work product (git diff,
  captured test/lint outputs, trace) is verified and routed
  continue/stop/escalate, plus a revert check. See
  [Outcome gate](#outcome-gate) below.
- **Command guard** — destructive-looking shell commands are judged against
  the current task before execution. See
  [Command guard](#command-guard) below.
- **Tool guard** — call-level waste detection for cheap workers that are
  weak at tool use: repeated identical calls, identical retries after a
  failure, and 3+ re-reads of the same file are judged and confident
  thrash is blocked with a corrective reason. See
  [Tool guard](#tool-guard) below.
- **Recall rerank** — when the `recall` tool's exact query misses and BM25
  keyword fallback returns candidates, the judge scores each for relevance
  and drops the confidently irrelevant ones (a weak model otherwise chases
  junk snippets). Exact matches are never reranked.
- **Consult routing** — when the worker calls `consult` without naming a
  model, the judge assigns one from the registry by role, capability
  `classes`, cost, and guardrail fit — cheapest model that covers the
  need. Below `judge.minConfidence` the `default`-classed model applies;
  the approval gate still owns the final say.
- **Consult approval** — with `approval.consultTool: "judge"`, the approve
  node clears clearly justified consults without a prompt and defers to
  the ask dialog when unsure. See [Approval gate](#approval-gate).
- **Prescreen** — one parallel call scores false-refusal risk over the
  staged files and flags trigger families (exploit-like code, RE artifacts,
  secrets, sensitive prose). Falls back to `prescreen.model`, then to
  `unknown`.

Degradation is part of the contract: no key, timeout, HTTP error, or
`"enabled": false` all mean `judge()` returns nothing and the fallback path
runs — a session never breaks because the classifier is missing.

- `judge.provider` — backend id (`typesafe` today). Backends implement one
  interface (`lib/judge/types.ts`), so the classifier is replaceable — e.g.
  a future local classifier head or fine-tuned LoRA — without touching call
  sites.
- `judge.model` — model alias, default `jev-latest`.
- `judge.apiKeyEnv` — env var holding the key, default `TYPESAFE_API_KEY`.
- `judge.timeoutMs` — per-call budget before falling back, default 4000.
- `judge.minConfidence` — floor for overruling deterministic heuristics,
  default 0.55.
- `judge.maxCallsPerMinute` — fabric-wide rate cap across all nodes,
  default 30. Beyond it, calls degrade to heuristics for the rest of the
  minute.
- `judge.fallback` — the naive-llm tier: `baseUrl` (OpenAI-compatible,
  e.g. `http://127.0.0.1:8080/v1`; unset = no tier), `model`, `apiKeyEnv`,
  `maxTokens` (default 500). Runs when the primary is unconfigured, times
  out, errors, or answers unusably.
- `judge.trace` — default true: every answered call, whichever tier
  answered it, appends one **ready-to-train row** to
  `<logDir>/judge-YYYY-MM.jsonl`:
  `{ts, node, source, elapsedMs, context, schema, labels}`. That is
  exactly the shape a parallel-constrained-decoding head (a small local
  model answering a whole schema of boolean/enum fields in one broadcast
  pass, e.g. Qwen2.5-1.5B) trains on — `lib/judge/serialize.ts` owns the
  folding (`noul` → boolean field, `choice`/`score` → enum fields with
  rubrics in the description, state → context, answers → `{value, prob,
  probs}` soft labels). `source` names the answering tier
  (`typesafe:jev-1.13` vs `naive-llm:...`), so weaker self-reported labels
  are filtered or down-weighted at training time — that provenance is what
  keeps the dataset clean while the naive tier keeps data flowing even
  with no Jev key. Once trained, point `judge.provider` at your own
  backend and the whole fabric moves off the paid API without touching a
  call site.
- `judge.enabled` — master switch (also toggled from `/geocine judge`).

Verdicts land in the consult-log (`tier: "judge"` on watchdog records,
`screener: "judge:<model>"` on prescreen records, `triage` records for
routing, `gate` records for outcome verification, `guard` records for
command risk), so judge decisions feed the same fine-tuning flywheel as
everything else.

## Triage (task routing)

Judge-powered "is this task hard for a 27B, and should it go to the
frontier?" — decided against the session stage, because the economics move:
early in a session a handoff brief is small and lossless; deep in one, the
local model's warm KV cache makes staying cheap per turn while a handoff
loses invested state. Requires a configured judge; silently off without
one. Runs only while the active model is a cheap local provider
(`rescue.localProviders`) — routing exists to help the local worker, so a
frontier main model is never steered.

Two moments:

- **Task start** (`extensions/triage.ts`) — every non-command user message
  is judged (fire-and-forget, zero added latency): a 0–3 difficulty score
  for the local model plus a route choice — `local`, `plan_first` (one
  consult for a plan, local execution), or `frontier` (hand the whole
  problem off). A confident non-local route steers the model toward an
  early consult naming the resolved rescuer; the approval gate still owns
  the spend.
- **Mid-task** (rides the watchdog's every-turn judge call as a parallel
  question, so it costs no extra request) — the probability that handing
  off *now* beats continuing locally, given `session_stage` (turn, invested
  tokens, % of window) and the recent tool calls. Above
  `triage.escalateThreshold` it appends to a failure hint, or fires a
  standalone suggestion on quiet turns — grinding without errors on a
  too-hard task is exactly the case counters can never see.

Every verdict is logged as a `TriageRecord` (task snippet, difficulty,
route, confidence, context tokens) — task→route labels are the training
data for a future local router.

- `triage.enabled` — master switch. Default true.
- `triage.escalateThreshold` — escalate-now probability needed to suggest a
  consult mid-task. High on purpose (default 0.75): the suggestion
  interrupts the loop.
- `triage.cooldownTurns` — minimum turns between two escalate suggestions.
  Default 8.

## Outcome gate

The watchdog judges the *activity trace* while the agent runs; the gate
(`extensions/outcome-gate.ts`) judges the *work product* when it stops:

```
task, git diff, test/lint outputs, trace, stage ──► judge
                                                      │
                                    continue        stop        escalate
                                       │                            │
                                 nudge local on          suggest frontier consult
```

Evidence is gathered, never regenerated: `git diff` / `git status` are read
directly (capped at `gate.maxDiffChars`), and test/lint/build results are
captured from tool outputs the agent already produced during the run — the
gate never runs a test suite itself. One judge call answers all questions
in parallel (System One generates outputs together, so extra questions are
nearly free):

- `done` — calibrated "complete and correct?" probability. A task that
  needed code changes but shows no diff, or failing checks, is not done.
- `next` — the `continue`/`stop`/`escalate` route, weighed against the
  session stage.
- `revert` — did checks regress from passing to failing while the diff
  kept growing? A confident "digging deeper" verdict makes the continue
  nudge advise reverting to the last good state instead of forward-fixing
  on top of broken changes.
- Review flags (advice, never blocking): `regression_risk` (diff touches
  shared behavior without coverage), `scope_creep` (off-task edits mixed
  in), `architectural_change` (structural rather than local — worth a
  stronger reviewer), `needs_more_tests` (changed behavior with no test
  evidence). Confident flags land in the status line and sharpen the
  nudge text.
- `needs_human` — a safety override: when what remains hinges on a
  decision only the user can make (product choice, irreversible step,
  ambiguous requirement), nudges are suppressed entirely, whatever the
  router said. Automatic continuation must never guess through a human
  decision point.

Actions are deliberately conservative:

- `stop` — a status line only: "looks done" or "needs your review".
- `continue` — the local model likely can finish: one idle nudge naming the
  concrete evidence (failing checks, missing diff) restarts it. Local
  models settle prematurely often enough that this is the gate's biggest
  win.
- `escalate` — the nudge suggests the consult tool with the resolved
  rescuer; the approval gate still owns the spend.

Nudges are capped at `gate.maxNudgesPerTask` per user task (a nudge starts
a new local run), confidence-gated by `judge.minConfidence`, restricted to
cheap local main models (`rescue.localProviders` — an expensive main model
gets the verdict as a status line, never an auto-run), and a settle with
no new tool activity is never re-gated — so a nudged run that changes
nothing cannot loop. Every verdict is a `GateRecord` (done probability,
route, diff stat, checks seen) for the flywheel.

- `gate.enabled` — master switch. Default true (needs a configured judge).
- `gate.maxNudgesPerTask` — automatic re-run cap. Default 1.
- `gate.maxDiffChars` — diff evidence budget. Default 8000.

## Command guard

The fabric's "risky?" node for shell commands
(`extensions/command-guard.ts`). A deterministic prefilter catches
destructive-looking commands — recursive deletes (`rm -rf`), hard resets,
`git clean -f`, force pushes, `DROP TABLE`, `Remove-Item -Recurse -Force`,
disk tools — so the judge only ever sees the rare suspect and routine
commands pay zero latency. The judge then answers one question with the
task as context: does this command serve the task, or is it likely
collateral damage? A destructive command the task plainly asks for ("reset
the repo") passes; a hard reset nobody asked for is blocked via the
`tool_call` event with a reason the model sees, instructing it to scope
down or ask the user first (`ask_user` tool). A blocked retry fails the
same way, which feeds the watchdog's fail streak — the fabric composes.

Degradation: no judge, timeout, or rate cap = allow. pi's own
tool-approval settings remain the real permission system; this node only
adds a task-aware check for sessions running with broad approvals. Every
judged command is a `GuardRecord` (command, task, risk, blocked).

- `guard.enabled` — master switch. Default true (needs a configured judge).
- `guard.blockThreshold` — collateral-damage probability needed to block.
  High on purpose (default 0.8): wrongly blocking a legitimate command is
  worse than deferring to pi's approval flow.

## Tool guard

The fabric's call-level "wasteful?" node (`extensions/tool-guard.ts`), for
cheap workers that are weak at tool use — the watchdog catches thrashing at
turn granularity, but a weak model burns most of its tokens at call
granularity. A deterministic prefilter tracks completed calls per task:
an exact call already run twice, an identical retry of a call that already
failed, or a fourth read of the same file flags the call as a suspect —
everything else pays zero latency. The judge then decides with the task and
the last ten calls in view: redundant thrash (nothing changed, the result
will be the same) is blocked via the `tool_call` event with a corrective
reason — use the `recall` tool for earlier output, change the approach, or
state what new information the repeat would produce. Legitimate repeats
(re-reading a file after editing it, re-running a build after a fix) pass,
because the judge sees the edit in the recent calls.

Frontier workers are never guarded — the node only arms when
`rescue.localProviders` matches the active model. Blocks are capped per
task and cooled down between hits so the guard corrects rather than nags.
Degradation: no judge, timeout, or rate cap = allow. Every judged call is
a `tool_guard` record (tool, call, trigger, wastefulP, blocked).

- `toolGuard.enabled` — master switch. Default true (needs a configured
  judge).
- `toolGuard.blockThreshold` — wasteful probability needed to block.
  Default 0.8.
- `toolGuard.maxBlocksPerTask` — blocks per user task before the guard goes
  quiet. Default 3.

## Context keeper

- `context.providers` — which model providers get context-keeper machinery
  at all (early/idle compaction, reminder, pruner, and the arc/checkpoint
  compaction override). Default `["llama.cpp", "lmstudio", "ollama"]` —
  genuinely local servers where prompt re-ingest is slow. Any other model
  selected in the picker (cloud APIs, abliteration-ai, …) uses pi's
  built-in compaction untouched; the `recall` and `note` tools stay
  available everywhere.
- `context.mode` — compaction style: `"arc"` (deterministic digest, no
  model call, default), `"checkpoint"` (LLM-written structured checkpoint),
  or `"off"` (pi default).
- `context.recall` — the transcript search tool (exact regex primary, BM25
  fallback on zero matches, full entry read-back via `entry`/`offsetChars`).
  Default on.
- `context.rerank` — judge-rerank the BM25 fallback results: each fuzzy
  candidate is scored for relevance to the query in one parallel judge call
  and confidently irrelevant ones are dropped before the model sees them.
  Exact matches are never reranked; the filter never empties the result
  list; no judge = pass-through. Default on.
- `context.notes` — the `note` tool; notes are pinned verbatim into every
  compaction digest. Default on.
- `context.reminderTokens` — pre-compaction reminder lead: within this many
  tokens of `compactAtTokens`, the model is told once to pin load-bearing
  facts before the cut. Default 8000; 0 disables.
- `context.compactAtTokens` — compact early at this many tokens while a
  `context.providers` provider is active (pi's own threshold, contextWindow
  − reserve, is minutes of prompt re-ingest too late on local hardware).
  Unset = off.
- `context.idleCompactMinutes` — also compact after N idle minutes once the
  context is past half the threshold. Unset = off.
- `context.pruner` — ingestion-time trimming of oversized bash/powershell
  outputs (cache-neutral; the full output stays searchable via recall).
  Default on.
- `context.summarizer` — checkpoint mode only: registry entry whose model
  writes the checkpoint (default: the session's own model, which reuses the
  warm KV cache).
- `context.maxTokens`, `prunerThresholdChars`, `prunerHeadChars`,
  `prunerTailChars` — budgets.
- `qwen.auto` / `qwen.level` — persisted Qwen thinking state, set via
  `/harness auto` and `/harness <level>` (written automatically by the
  command; survives restarts and `/reload`).
- `qwen.imageLevel` — thinking level for turns whose latest message contains
  an image (fresh screenshot or attachment). Overrides both the manual level
  and auto mode for that request only; follow-up tool turns return to the
  normal policy. Vision ingestion already dominates the prompt on local
  models, so `"low"` or `"off"` keeps image turns fast. Set via
  `/harness image <level|inherit>`; omit (or pick `inherit`) for no override.

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
- `rescue.localProviders` — the providers that count as the **cheap
  worker**. This list does double duty: switching away from one starts a
  rescue episode, and the machinery that injects messages or blocks calls
  (triage steers, gate nudges, tool guard) arms only while the active
  model is from one. "Local" is shorthand for cheap, not physically local —
  the default already includes hosted abliteration-ai, and a budget cloud
  host (e.g. `baseten` running Qwen) belongs here too. The worker itself is
  never designated: it is whatever pi's model picker has active, read per
  event, and nothing here switches it.
- `rescue.distillModel` — who drafts `/distill` lessons (default:
  the prescreen model).

See [training-data.md](training-data.md) for what the episodes are for.

## Pre-screen

- `prescreen.model` — which local model screens staged content
  for guardrail false-positive risk before strict cloud models see it.
- `prescreen.maxBytes` — staged bytes shown to the screener.

## Testing quickly

```bash
# 1. Load check — session starts, /geocine opens the hub menu:
pi
/geocine
/models
/watchdog status

# 2. bash-repair: ask the model to run a failing pytest/go test; the tool
#    result should start with a [failfmt] block.

# 3. consult (lenient, free): /consult @cheap what does this repo do?

# 4. consult tool end-to-end: ask the main model to
#    "consult about <question> staging only <file>" and watch the status bar.
```
