# Training data: the decision log, judge trace, and rescue episodes

The point of logging everything is a flywheel with two loops: fine-tune the
**local worker** on rescue episodes and briefing→advice pairs so it consults
less, and train your own **offline judge head** on the trace of every fabric
decision so the decisions themselves run free.

## Decision log

Append-only JSONL under `~/.pi/agent/consult-log/YYYY-MM.jsonl`, one
correlation id (`cid`) per consultation/incident:

`consult_request` (with approval + routing provenance) → `staging`
(manifest, bytes) → `prescreen` (risk, triggers) → `consult_result`
(advice, refusal flag, files-read utilization, usage), plus `watchdog`
verdict records with their decision-time digests, `triage` records
(task → route with difficulty/escalate probabilities), `gate` records
(outcome-gate verdicts with their review flags), `guard` records
(command + risky-probability + blocked/allowed), `tool_guard` records
(flagged tool call + trigger + wasteful-probability + blocked), `rescue` episode
records, and `compaction` records (summarizer, tokens replaced, outcome).

What each record type trains:

| Signal | Label it provides |
| --- | --- |
| Approval denials (`approval: "user_no"`) | "should not have consulted here" |
| Routing overrides (`chosenBy: "user_override"`) | "wrong model for this kind of problem" — including overrides of judge picks |
| Actual refusals (`refusalSuspected`) | guardrail-predictor labels for the prescreen |
| Briefing → advice pairs | distillation data for the local model |
| Watchdog digests → outcomes | escalation-policy training |
| Triage verdicts (`triage`) | task → route labels for a local router |
| Outcome-gate verdicts (`gate`) | "was it actually done" / revert / risk-flag labels |
| Command-guard decisions (`guard`) | destructive-command policy labels |
| Tool-guard decisions (`tool_guard`) | wasteful-call detection labels for weak tool-callers |
| Staging manifest vs files actually read | context-curation quality |

`/geocine log` shows this month's record counts.

## Judge trace

Separate from the decision log: with `judge.trace` on (default), every
**answered** fabric call appends one row to
`~/.pi/agent/consult-log/judge-YYYY-MM.jsonl`:

```json
{"ts": "...", "node": "gate", "source": "jev", "elapsedMs": 240,
 "context": "<the serialized state the judge saw>",
 "schema": {"done": {"type": "boolean", "description": "..."}},
 "labels": {"done": {"value": "true", "prob": 0.93, "probs": {...}}}}
```

That `(context, schema, labels)` shape is exactly what a parallel
constrained-decoding head (a small model answering a whole schema of
boolean/enum fields in one pass) trains on — noul questions folded to
boolean fields, choice/score to enum fields, answers kept as soft labels
with full probability mass. The naive-llm fallback tier prompts with this
same serialization, so logged rows, fallback inference, and the future
head share one format: train/serve parity by construction.

`source` separates calibrated Jev labels from `naive-llm` ones, so weak
labels can be filtered or down-weighted at training time. Once your head
is trained, repoint `judge.provider` at it and every fabric decision —
triage, watchdog, gate, guard, toolcall, recall, routing, prescreen — runs locally at zero
marginal cost. `/geocine judge` shows per-node call stats and the trace
location.

## Rescue episodes

The highest-value pairs come from *manual* rescues: the local model grinds,
you switch to a frontier model, it fixes the thing. Two capture paths:

- **Live**: `extensions/rescue.ts` watches `model_select`. Switching away
  from a `rescue.localProviders` provider starts an episode; switching back
  (or session end) writes a `rescue` record: failure digest (the local
  model's last ~30 entries), the rescuer's tool events, files touched, its
  final summary.
- **Retroactive**: pi session JSONL stamps every `model_change` and every
  assistant message with its model, so history is minable offline:

  ```bash
  node scripts/mine-rescues.mjs                    # scans ~/.pi/agent/sessions
  node scripts/mine-rescues.mjs --out rescues.jsonl --min-actions 2
  ```

  Each output line is `{failure_context, rescue_trajectory, fromModel,
  toModel, filesTouched, ...}` — SFT-ready raw material: train the local
  model on (failure context → rescuer trajectory), and the switch events
  themselves label the escalation policy ("should have consulted here").

## Lessons

`/distill` turns the latest rescue episode (this session or from the log)
into a one-lesson markdown draft under `~/.pi/agent/rescue-lessons/`:

```
# <short imperative title>
**When:** <the recognizable symptom>
**Do:** <the approach that worked>
**Why the naive approach fails:** <one sentence>
```

Drafts have `status: draft` frontmatter and are **never injected into any
prompt**. Promoting one into `AGENTS.md` or a skill is a deliberate human
step (`/geocine lessons` → "Paste into editor (to promote)") — the prompt
never grows without a human decision.
