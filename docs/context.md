# Context management (`context-keeper`)

Long sessions die one of two deaths: the context fills with stale tool
output, or compaction summarizes away the one detail you needed an hour
later. `context-keeper` attacks both with three mechanisms, configured under
the `context` block of `geocine.json`.

## Design position

Summarization-only compaction is lossy, and the loss compounds: each
checkpoint summarizes the previous checkpoint's survivors. Recent work
converges on a different shape — keep summaries cheap and shallow, keep the
**raw history retrievable**, and let the agent pull details back on demand:

- **ACM** ([alphaXiv 2607.23809](https://www.alphaxiv.org/abs/2607.23809))
  gives the agent `manage_context` (offload + summarize) and `query_memory`
  (targeted retrieval from the offloaded raw log). Lossless in effect,
  because nothing is deleted — only moved out of the window.
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
  keeps a 0.16 verbatim tail, and prunes tool results first.
- **ACM** (paper above): keeps the working set at 20–60k tokens with
  proactive "sawtooth" compaction well before any hard limit.

`context.compactAtTokens` adds the dsh/ACM-style early trigger: after each
turn, if the context exceeds the threshold **and a local provider is
active** (`rescue.localProviders`), the keeper calls compaction itself.
60000 is a good default for ~500 tok/s hardware. Cloud models are left to
pi's own threshold.

**Hybrid recurrent models (Qwen3.8 class) make this critical.** Their
recurrent state cannot be partially rolled back like a standard KV cache:
if a request diverges from the cached sequence anywhere but the tip,
llama.cpp rolls back to the nearest saved checkpoint — often near position
0 (`find_slot: non-consecutive token position …` in the server log is the
telltale). And divergence happens *every turn* when thinking is on, because
the Qwen chat template strips prior-turn `<think>` blocks from resent
history. Keeping the context small is the only real defense. Server-side,
raise `--ctx-checkpoints` (default 32) so rollback points are denser, and
consider a smaller `-c` so pi's own threshold also fires sooner.

## 1. Tool-result pruner (deterministic, model-free — **opt-in**)

When enabled (`"pruner": true`), tool results **older than the last
`prunerProtectRecent` (default 6)** whose text exceeds
`prunerThresholdChars` (default 6000) are trimmed to
`prunerHeadChars` + `prunerTailChars` (default 1500 + 1500) around a marker:

```
[geocine-pi: pruned 41230 chars from the middle of this old tool result.
 The full output is in the session transcript — use the recall tool to search it.]
```

Ported from deepseek-harness's `compaction-tool-result-pruner`. Properties:

- **Non-destructive** — pi's `context` event mutates a per-request copy;
  the session log keeps the full output, so `recall` can still search it.
- **Free** — no model call. It delays compaction by cutting dead weight
  first, which is the deepseek-harness ordering: prune, then summarize.
- **Off by default** — each result that newly ages past the protection
  window mutates the prompt *mid-context*. Cloud providers just re-read a
  suffix; a local standard-KV server re-ingests from the edit point; a
  hybrid recurrent model re-ingests nearly everything. Enable it only where
  prompt processing is cheap.

## 2. `recall` tool (transcript history lookup)

An LLM-callable tool that regex-searches the **full raw session
transcript** — including spans hidden by compaction and text removed by the
pruner — and returns snippets, newest first. This is ACM's `query_memory`
and the Codex-style transcript lookup in pi terms.

The checkpoint summary ends with a footer telling the model the tool
exists, so after a compaction the model reaches for `recall` instead of
re-reading files or re-running commands to reconstruct what it forgot.

## 3. Checkpoint compaction (prefix-cache-aligned)

Replaces pi's default compaction summary via `session_before_compact`.
Differences from stock pi:

- **Structured checkpoint** (ported from deepseek-harness
  `compaction-basic`): fixed sections — Primary Request and Intent, Key
  Technical Concepts, Files and Code, Errors and Fixes, Pending Jobs,
  Current Work, Next Step, Critical Context — with rules to preserve exact
  paths/commands/error strings and to *merge* (not copy) a prior checkpoint.
- **Prefix-cache alignment**: the summarization call replays the session's
  own system prompt and the actual conversation messages, then appends the
  instruction as the final user message. The call is a genuine prefix of
  the last request, so the provider's KV cache is reused — on a single-slot
  llama.cpp server the summarization is nearly free instead of re-ingesting
  the whole conversation. (Stock pi deliberately routes compaction as a
  cache-cold one-off; that's the right call for cloud pricing, the wrong
  one for a local server.)
- **Shrink guarantee**: if the summary is not clearly smaller than what it
  replaces, the extension falls back to pi's default compaction rather than
  landing a bad trade.
- **Configurable summarizer**: `context.summarizer` names a consultant
  whose model writes the checkpoint. Unset, the session's own model is used
  — for the local-first setup this is usually right (free + warm cache).

Every compaction lands a `compaction` record in the consult-log
(`reason`, summarizer, `tokensBefore`, summary size, outcome, latency).
`recall` calls made shortly after a compaction are a utilization signal:
they mark exactly what the checkpoint failed to carry forward — future
training data for a better local summarizer.

## Configuration

```jsonc
"context": {
  "checkpoint": true,            // structured checkpoint compaction (default on)
  "compactAtTokens": 60000,      // early compaction while a local provider is active (0/unset = pi default)
  "summarizer": "local-big",     // optional: consultant name; default = session model
  "maxTokens": 4096,             // checkpoint length cap
  "recall": true,                // transcript search tool (default on)
  "pruner": false,               // old-tool-result trimming — OPT-IN (mid-context edits cost re-ingest locally)
  "prunerThresholdChars": 6000,
  "prunerHeadChars": 1500,
  "prunerTailChars": 1500,
  "prunerProtectRecent": 6
}
```

Toggle checkpoint/pruner/recall from `/geocine context`.
