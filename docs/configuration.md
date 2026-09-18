# Find the setting you came for

You don't need to read this page from top to bottom. Search for the
setting that surprised you, change it, and get back to the task.

**The global file sets your defaults. A project file overrides them.**

## Where does configuration live?

```text
~/.pi/agent/geocine.json
```

Copy [`geocine.example.json`](../geocine.example.json) there. A project
can override it with `.pi/geocine.json`.

Sections merge shallowly. `models` merge by entry name, project values
win, and most settings reload on each event.

---

## Which models can Pi choose?

```jsonc
{
  "models": {
    "qwen-27b": {
      "provider": "llama.cpp",
      "model": "owner/model:quant",
      "role": "local coding and research",
      "classes": ["local", "cheap", "fast", "vision"],
      "rank": 1,
      "thinking": "medium",
      "jail": "none",
      "prescreen": false,
      "autoApprove": false,
      "notes": "Optional briefing note"
    }
  }
}
```

| Field | Default | What it changes |
| --- | --- | --- |
| `provider` | none | Pi provider id |
| `model` | required | Pi model id |
| `role` | general consultant | One-line routing description |
| `classes` | `[]` | Capabilities and routing handles |
| `rank` | unranked | Lower wins inside one class |
| `thinking` | provider default | Child-run thinking level |
| `jail` | `staged` | Staged context firewall, live `none`, or per-consult `auto` |
| `prescreen` | `false` | Screens staged content before a strict consult |
| `autoApprove` | `false` | Skips approval for this model |
| `notes` | none | Extra bounded briefing text |

| Class | Runtime meaning |
| --- | --- |
| `default` | No-target consultation fallback |
| `local` | Cheap-worker behavior, context keeper, and local-first permissive routing |
| `cheap` | Cheap-worker steering and guards |
| `abliterated` | Permissive routing candidate |
| `frontier` | Strong consultation target |
| `fast`, `intelligent`, `vision` | Addressable capabilities |

You can use any class as a handle, such as `/consult @vision`.
`llama.cpp` entries disappear from pickers while their server or model is
unavailable.

Flow: [consult routing](consultation-routing.md),
[isolation](consultation-isolation.md), and [triage](triage.md).

---

## Who may approve a consultation?

| Setting | Default | What it changes |
| --- | --- | --- |
| `approval.consultTool` | `ask` | Uses `ask`, `judge`, or `auto` for worker tool calls |
| `approval.approveThreshold` | `0.85` | Probability needed to skip your prompt |
| `prescreen.model` | none | Registry model used as local screener |
| `prescreen.maxBytes` | `24576` | Maximum staged bytes screened |

Your `/consult` command is direct intent, so it bypasses approval.

Flow: [approval](consultation-approval.md) and
[pre-screening](consultation-prescreen.md).

---

## When does triage act?

| Setting | Default | What it changes |
| --- | --- | --- |
| `triage.enabled` | `true` | Enables task-start and lease judgments |
| `triage.escalateThreshold` | `0.75` | Probability needed for a mid-task consult suggestion |
| `triage.cooldownTurns` | `8` | Turns between suggestions |

Triage stays silent when no judge is configured.

Flow: [triage and model leases](triage.md).

---

## Which runtime control can interrupt?

### Watchdog

| Setting | Default | What it changes |
| --- | --- | --- |
| `watchdog.enabled` | `true` | Enables counters and judgments |
| `watchdog.judgeEveryTurn` | `true` | Judges each turn with new tool activity |
| `watchdog.sendHints` | `true` | Sends corrective hints to cheap workers |
| `watchdog.hintCooldownTurns` | `4` | Turns between hints |
| `watchdog.loopThreshold` | `3` | Same calls that count as a loop |
| `watchdog.failStreakThreshold` | `3` | Failed commands that count as stuck |
| `watchdog.baseUrl` | none | Separate OpenAI-compatible endpoint |
| `watchdog.model` | none | Model on that endpoint |
| `watchdog.apiKeyEnv` | none | Environment variable holding its key |

Don't point `watchdog.baseUrl` at the active one-slot worker server.

### Outcome gate

| Setting | Default | What it changes |
| --- | --- | --- |
| `gate.enabled` | `true` | Verifies work when the agent settles |
| `gate.maxNudgesPerTask` | `1` | Caps automatic continuations |
| `gate.maxDiffChars` | `8000` | Caps diff evidence sent |

### Command guard

| Setting | Default | What it changes |
| --- | --- | --- |
| `guard.enabled` | `true` | Judges destructive-looking commands |
| `guard.blockThreshold` | `0.8` | Collateral-risk probability needed to block |

### Tool guard

| Setting | Default | What it changes |
| --- | --- | --- |
| `toolGuard.enabled` | `true` | Judges repeated calls from cheap workers |
| `toolGuard.blockThreshold` | `0.8` | Waste probability needed to block |
| `toolGuard.maxBlocksPerTask` | `3` | Caps interventions in one task |

Flow: [runtime control](runtime-control.md).

---

## How does TypeSafe connect?

| Setting | Default | What it changes |
| --- | --- | --- |
| `judge.enabled` | configured state | Master switch |
| `judge.provider` | `typesafe` | Registered judge backend |
| `judge.baseUrl` | `https://api.typesafe.ai` | Host origin or full evaluation URL |
| `judge.model` | `jev-latest` | Backend model id |
| `judge.apiKeyEnv` | host-specific | Environment variable holding the key |
| `judge.maxInputTokens` | `32000` | State and question budget |
| `judge.timeoutMs` | `4000` | Per-call timeout |
| `judge.minConfidence` | `0.55` | Confidence needed to overrule a heuristic |
| `judge.maxCallsPerMinute` | `30` | Shared rate cap |
| `judge.trace` | `true` | Appends answered calls to JSONL |
| `judge.traceDir` | `logDir` | Trace directory |
| `judge.maxTokens` | `500` | Top-level naive completion cap |

| Fallback setting | Default | What it changes |
| --- | --- | --- |
| `judge.fallback.baseUrl` | none | OpenAI-compatible endpoint |
| `judge.fallback.model` | none | Fallback model |
| `judge.fallback.apiKeyEnv` | none | Key environment variable |
| `judge.fallback.maxTokens` | `500` | Completion cap |

Official TypeSafe uses `TYPESAFE_API_KEY`. OpenRouter uses
`baseUrl: "https://openrouter.ai"`, model `~typesafe/jev-latest`, and
`OPENROUTER_API_KEY`.

Flow and wire payload: [decision fabric](decision-fabric.md).

---

## What context reaches the worker?

| Setting | Default | What it changes |
| --- | --- | --- |
| `context.providers` | `["llama.cpp", "lmstudio", "ollama"]` | Keeper fallback for unregistered models |
| `context.mode` | `arc` | Uses `arc`, `checkpoint`, or `off` |
| `context.checkpoint` | none | Deprecated; `false` means `off` |
| `context.summarizer` | active model | Registry model used by checkpoint mode |
| `context.maxTokens` | `4096` | Checkpoint output cap |
| `context.compactAtTokens` | disabled | Early-compaction threshold |
| `context.idleCompactMinutes` | disabled | Idle-compaction delay |
| `context.pruner` | `true` | Trims oversized shell output at ingestion |
| `context.prunerThresholdChars` | `6000` | Result size that triggers pruning |
| `context.prunerHeadChars` | `1500` | Prefix retained |
| `context.prunerTailChars` | `1500` | Suffix retained |
| `context.notes` | `true` | Registers and pins `note` entries |
| `context.reminderTokens` | `8000` | Pre-cut reminder lead; `0` disables |
| `context.recall` | `true` | Registers transcript search |
| `context.rerank` | `true` | Judge-reranks fuzzy candidates |
| `context.judgeDigest` | `true` | Scores digest steps and stale notes |
| `context.memory` | `true` | Gates task-start memory |

Flow, examples, and research: [context management](context.md).

---

## Which tools does the model see?

| Setting | Default | What it changes |
| --- | --- | --- |
| `harness.aliases` | `true` | Exposes trained tool names at the wire boundary |
| `qwen.auto` | `false` | Thinks on user turns and failed tools |
| `qwen.level` | `off` | Uses `off`, `low`, `medium`, `high`, `xhigh`, or `max` |
| `qwen.imageLevel` | inherit | Overrides thinking for image turns |
| `web.provider` | `auto` | Uses `auto`, `tinyfish`, or `builtin` |
| `web.tinyfishApiKey` | `TINYFISH_API_KEY` | Literal key or `$ENV_NAME` |
| `pdf.maxChars` | `24000` | Caps one `read_pdf` result |
| `pdf.maxSearchMatches` | `40` | Caps search results |

Flow: [model harness and tools](model-tools.md).

---

## Which decisions become data?

| Setting | Default | What it changes |
| --- | --- | --- |
| `rescue.enabled` | `true` | Captures manual cheap-to-frontier rescues |
| `rescue.localProviders` | `["llama.cpp", "lmstudio", "ollama", "abliteration-ai"]` | Cheap-worker fallback for unregistered models |
| `rescue.distillModel` | pre-screen model | Registry model used by `/distill` |
| `logDir` | `~/.pi/agent/consult-log` | Decision and judge-trace directory |

Registered models use their `cheap` and `local` classes. The provider
list only covers unregistered models.

Flow: [training data](training-data.md).

---

## Which environment variables matter?

| Variable | Default | What it changes |
| --- | --- | --- |
| `BASETEN_RPM` | `14` | Client request window |
| `BASETEN_TPM` | `90000` | Client token window |
| `TINYFISH_API_KEY` | none | TinyFish web credential |
| `TYPESAFE_API_KEY` | none | Official TypeSafe credential |
| `OPENROUTER_API_KEY` | none | OpenRouter judge credential |

`/geocine` shows live state and common controls. `/geocine config` opens
the active global file.

**Search, change, return to work.**
