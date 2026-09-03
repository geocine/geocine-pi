# Context management (`context-keeper`)

Long sessions die one of two deaths: the context fills with stale tool
output, or compaction summarizes away the one detail you needed an hour
later. `context-keeper` attacks both, configured under the `context` block
of `geocine.json`.

## Design position

Summarization-only compaction is lossy, and the loss compounds: each
checkpoint summarizes the previous checkpoint's survivors. Recent work
converges on a different shape — keep the in-context digest cheap and
shallow, keep the **raw history retrievable**, and let the agent pull
details back on demand:

- **ACM** ([alphaXiv 2607.23809](https://www.alphaxiv.org/abs/2607.23809))
  gives the agent `manage_context` (offload + summarize) and `query_memory`
  (targeted retrieval from the offloaded raw log). Lossless in effect,
  because nothing is deleted — only moved out of the window.
- **ARC** ([alphaXiv 2607.25066](https://www.alphaxiv.org/abs/2607.25066)):
  compaction does not need an LLM at all. Replace old content with
  deterministic citation stubs and give the agent a `recall` tool; on
  needle-recovery evals this beat LLM summarization 99.4% vs 88.1% —
  paraphrase is where the loss lives.
- **TokenPilot** ([alphaXiv 2606.17016](https://www.alphaxiv.org/abs/2606.17016)):
  trim noise **at ingestion**, not retroactively — a tail append never
  invalidates the provider prefix cache, a mid-context edit always does.
- **Raw-log search rivals structured memory**
  ([alphaXiv 2608.12888](https://www.alphaxiv.org/abs/2608.12888)):
  agent-controlled search over unprocessed transcripts matches or beats
  summaries/embeddings/knowledge-graph memory. The transcript itself is a
  fine memory store; what's missing is a search tool.
- **Compression has hidden interaction costs**
  ([alphaXiv 2608.16370](https://www.alphaxiv.org/abs/2608.16370)):
  task-completion metrics hide the extra turns agents spend *re-acquiring*
  state that compression dropped (re-reading files, re-running commands).
  Retrieval from the transcript is cheaper than re-derivation.

This is also the direction Codex CLI is reportedly heading (hard context
cutovers + notes + transcript history lookup) — and pi is well positioned
for it, since pi's session log already keeps every entry; compaction only
hides them from the projection. `context-keeper` closes the loop by adding
the retrieval half.

## 0. When compaction triggers (and why pi's default is too late locally)

How the engines decide:

- **pi**: compacts when `contextTokens > contextWindow − reserveTokens`
  (reserve default 16384). With a 262k-context local model that means
  compaction at ~245k tokens — but on a local server every context token is
  re-paid at prompt-processing speed whenever the cache misses. At 500
  tok/s, one cache miss on a 150k context is **5 minutes of "Working…"**.
- **deepseek-harness**: compacts at `thresholdRatio` 0.8 × context window,
  keeps a 0.16 verbatim tail, prunes tool results first, and also compacts
  when the session goes idle (`compactNow()`).
- **ACM** (paper above): keeps the working set at 20–60k tokens with
  proactive "sawtooth" compaction well before any hard limit.

`context.compactAtTokens` adds the dsh/ACM-style early trigger: when an
agent run settles, if the context exceeds the threshold **and a local
provider is active** (`rescue.localProviders`), the keeper calls compaction
itself. 60000 is a good default for ~500 tok/s hardware. Cloud models are
left to pi's own threshold.

`context.idleCompactMinutes` adds the dsh idle trigger: once the context is
past **half** of `compactAtTokens`, N minutes of idleness also compacts —
the cost lands while nobody is waiting, so the next prompt starts from a
small, warm context.

It deliberately waits for the run to settle rather than firing between
turns: mid-run the next LLM request is already in flight and an extension-
initiated compaction aborts it, killing the run. (pi's native threshold
compacts between requests inside the agent loop, but its `reserveTokens`
setting is global — a value tuned for a 262k local window would make small-
window cloud models compact constantly.) A run can therefore overshoot the
threshold by however much its tool loop adds; that overshoot is compacted
away as soon as the run ends.

**Hybrid recurrent models (Qwen3.8 class) make this critical.** Their
recurrent state cannot be partially rolled back like a standard KV cache:
if a request diverges from the cached sequence anywhere but the tip,
llama.cpp rolls back to the nearest saved checkpoint — often near position
0 (`find_slot: non-consecutive token position …` in the server log is the
telltale). And divergence happens *every turn* when thinking is on, because
the Qwen chat template strips prior-turn `<think>` blocks from resent
history. Keeping the context small is the only real defense. Server-side,
raise `--ctx-checkpoints` and lower `--checkpoint-min-step` so rollback
points are denser — see [local-qwen.md](local-qwen.md) for the full
recommended launch command.

## 1. Ingestion pruner (deterministic, cache-neutral, default on)

Oversized `bash`/`powershell` outputs are head/tail-trimmed **once, at the
moment they are captured** (`tool_result` event), before they ever enter
the prompt. Outputs above `prunerThresholdChars` (default 6000) keep
`prunerHeadChars` + `prunerTailChars` (default 1500 + 1500) around a marker:

```
[geocine-pi: trimmed 41230 chars from the middle of this large output at
 capture time. The full output is preserved in the session transcript —
 search it with the recall tool.]
```

This is TokenPilot's ingestion gate in pi terms, and it fixes the flaw of
retroactive pruning (the previous design, ported from deepseek-harness):
editing an *old* message mutates the prompt mid-context, which costs a
partial re-ingest on standard KV models and a near-full re-ingest on hybrid
recurrent models. An ingestion-time trim is just a shorter tail append —
the prefix cache never notices.

The full untrimmed output is stashed as a hidden session entry
(never sent to the LLM), so `recall` can still search every byte of it.
Only shell output is pruned: `read`/`grep` results are something the model
usually needs verbatim *right now*, and pi already caps those tools itself.

## 2. `recall` tool (transcript history lookup)

An LLM-callable tool that regex-searches the **full raw session
transcript** — including spans hidden by compaction and the full stashes of
pruned shell outputs — and returns snippets, newest first. This is ACM's
`query_memory`, ARC's `_recall`, and the Codex-style transcript lookup in
pi terms.

Every compaction summary ends with a footer telling the model the tool
exists, so after a compaction the model reaches for `recall` instead of
re-reading files or re-running commands to reconstruct what it forgot.

## 3. Compaction modes (`context.mode`)

### `"arc"` (default) — deterministic digest

ARC's core result is that the *summarization model* is the weak link:
paraphrase drops needles that deterministic stubs keep findable. So the
default compaction writes **no-LLM digest** of the compacted span:

- one terse line per step — user asks, assistant actions with tool calls,
  tool results as head/tail stubs with their size;
- thinking blocks dropped entirely;
- a carried-forward section from the previous digest (capped, oldest first
  to go);
- a budget (~10k chars): oldest lines fall off first, and the recall footer
  covers everything omitted.

Properties: **instant** (no model call — compaction latency goes from
minutes on a local server to zero), **no paraphrase loss** (nothing is
reworded, only elided — and everything elided is recoverable verbatim via
`recall`), and **deterministic** (same span → same digest).

### `"checkpoint"` — LLM-written structured checkpoint

The previous default, kept for when a narrative summary is worth the
latency (e.g. before handing a session to a different model). Ported from
deepseek-harness `compaction-basic`:

- fixed sections (Primary Request and Intent, Key Technical Concepts,
  Files and Code, Errors and Fixes, Pending Jobs, Current Work, Next Step,
  Critical Context) with rules to preserve exact paths/commands/error
  strings and to *merge* (not copy) a prior checkpoint;
- **prefix-cache alignment**: the summarization call replays the session's
  own system prompt and messages, then appends the instruction as the final
  user message — a genuine prefix of the last request, so a single-slot
  llama.cpp server reuses its KV cache instead of re-ingesting everything;
- **shrink guarantee**: a summary that is not clearly smaller than what it
  replaces falls back to pi's default compaction;
- `context.summarizer` names a consultant whose model writes the
  checkpoint (default: the session's own model — free + warm cache).

### `"off"` — pi's default compaction.

Every compaction lands a `compaction` record in the consult-log
(`reason`, summarizer or `deterministic`, `tokensBefore`, summary size,
outcome, latency). `recall` calls made shortly after a compaction are a
utilization signal: they mark exactly what the digest failed to carry
forward — future training data for a better local summarizer.

## Configuration

```jsonc
"context": {
  "mode": "arc",                 // arc (deterministic, default) | checkpoint (LLM) | off
  "compactAtTokens": 60000,      // early compaction while a local provider is active (0/unset = pi default)
  "idleCompactMinutes": 5,       // idle compaction past half the threshold (0/unset = off)
  "recall": true,                // transcript search tool (default on)
  "pruner": true,                // ingestion-time trim of big shell outputs (default on)
  "prunerThresholdChars": 6000,
  "prunerHeadChars": 1500,
  "prunerTailChars": 1500,
  "summarizer": "local-big",     // checkpoint mode only: consultant name; default = session model
  "maxTokens": 4096              // checkpoint length cap
}
```

Cycle the mode and toggle pruner/recall from `/geocine context`.
