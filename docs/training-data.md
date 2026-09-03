# Training data: the decision log and rescue episodes

The point of logging everything is a flywheel: use the setup, accumulate
labeled decisions, fine-tune the local model, consult less.

## Decision log

Append-only JSONL under `~/.pi/agent/consult-log/YYYY-MM.jsonl`, one
correlation id (`cid`) per consultation/incident:

`consult_request` (with approval + routing provenance) → `staging`
(manifest, bytes) → `prescreen` (risk, triggers) → `consult_result`
(advice, refusal flag, files-read utilization, usage), plus `watchdog`
verdict records with their decision-time digests, `rescue` episode
records, and `compaction` records (summarizer, tokens replaced, outcome).

What each record type trains:

| Signal | Label it provides |
| --- | --- |
| Approval denials (`approval: "user_no"`) | "should not have consulted here" |
| Routing overrides (`chosenBy: "user_override"`) | "wrong rescuer for this kind of problem" |
| Actual refusals (`refusalSuspected`) | guardrail-predictor labels for the prescreen |
| Briefing → advice pairs | distillation data for the local model |
| Watchdog digests → outcomes | escalation-policy training |
| Staging manifest vs files actually read | context-curation quality |

`/geocine log` shows this month's record counts.

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
