# Running the local Qwen3.8-27B server

The local-first setup assumes a llama.cpp `llama-server` on
`127.0.0.1:8080`. Recommended launch for Qwen3.8-27B:

```sh
llama-server --no-models-autoload --models-max 1 --host 127.0.0.1 --port 8080 -np 1 -ngl 99 \
  -c 262144 -fa on --cache-type-k q4_0 --cache-type-v q4_0 \
  --ctx-checkpoints 64 --checkpoint-min-step 2048 \
  --jinja
```

Why these flags matter for this model:

- **`-np 1` (single slot)** — one KV/recurrent-state cache, kept warm for
  the main session. A second parallel slot would halve the cache and let
  side requests evict it. This is also why the watchdog's optional
  mini-LLM must run on a *separate* server instance, never this one.
- **`--ctx-checkpoints 64 --checkpoint-min-step 2048`** — the critical pair
  for a hybrid recurrent model. Qwen3.8's recurrent state cannot be
  partially rolled back like a standard KV cache: on any prompt divergence
  before the tip, llama.cpp rolls back to the nearest saved checkpoint and
  re-ingests everything after it. The defaults (32 checkpoints, min step
  8192) leave rollback points sparse, so a divergence often re-ingests from
  near position 0 (`find_slot: non-consecutive token position ...` in the
  log). Denser checkpoints (64, every 2048 tokens) bound that re-ingest.
  Divergence is not rare here: the Qwen chat template strips prior-turn
  `<think>` blocks from resent history, so thinking turns diverge the
  prompt every time.
- **`-c 262144`** — full context. pi's own compaction threshold keys off
  this, but don't rely on it: on local hardware that threshold fires
  minutes-of-re-ingest too late. `context.compactAtTokens` (default 60000)
  plus `context.idleCompactMinutes` in `geocine.json` keep the working set
  small instead — see [context.md](context.md).
- **`-fa on --cache-type-k q4_0 --cache-type-v q4_0`** — flash attention +
  quantized KV cache so the 262k window fits in VRAM alongside `-ngl 99`
  (all layers on GPU).
- **`--jinja`** — use the model's own chat template. Required for Qwen's
  tool-call format; the Qwen model harness (`extensions/models/qwen.ts`) patches the rough edges
  (tool-call repair, schema quirks, thinking control).
- **`--no-models-autoload --models-max 1`** — serve exactly the one model,
  loaded on first request.

Sampling (temperature, top-p, etc.) can be set server-side
(`--temp 1 --top-p 0.95 --top-k 20 --min-p 0.00`, the Qwen-recommended
defaults) or left to the client.

With the server up, point pi at it via the `llama.cpp` provider and start a
session; the `geocine-pi` extensions (the Qwen model harness, context-keeper,
watchdog, consultants) do the rest.
