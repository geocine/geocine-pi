# Why did it choose that consultant?

The model name isn't the first decision. The real question is: which
*available* model can answer this well without wasting tokens?

**An explicit target wins. TypeSafe routes only when the worker leaves it blank.**

## How does a target win?

```mermaid
sequenceDiagram
    participant E as Consult entry
    participant A as Availability
    participant J as TypeSafe
    participant R as Registry

    E->>A: Check configured models
    A-->>E: Available pool + exclusions

    alt Name or class supplied
        E->>R: Resolve it
    else Worker supplied no target
        E->>J: Question + files + roster
        alt Confident choice
            J-->>E: Best fit
            E->>R: Resolve it
        else No trusted answer
            E->>R: Use default
        end
    else You supplied no target
        E->>R: Use default
    end

    alt Match is available
        R-->>E: Proposed consultant
    else Match is offline
        R-->>E: Stop with reason
    else Handle is unknown
        R-->>E: Stop with valid handles
    end
```

A name selects that registry entry. A class such as `vision` selects its
best carrier.

| What you supplied | What wins |
| --- | --- |
| Exact map key | That entry |
| Capability class | Best carrier |
| Nothing from the worker | TypeSafe, then the default |
| Nothing from `/consult` | The default |

Lower `rank` wins inside most classes. For `abliterated`, local comes
before hosted; `rank` breaks the remaining tie.

---

## What does TypeSafe classify?

```mermaid
flowchart LR
    S[Question + files + available roster] --> J[rescuer choice]
    J --> P[Choice + probability distribution]
    P -->|confidence meets minConfidence| R[Propose choice]
    P -->|lower or missing| D[Use default]
```

<details>
<summary>Open the actual TypeSafe POST body</summary>

```jsonc
{
  "state": {
    "question": "Which model should review this cache design?",
    "context": "The local worker found a cross-provider invalidation risk.",
    "files": ["lib/cache.ts"],
    "models": {
      "qwen-27b": {
        "role": "local coding and research",
        "classes": ["local", "cheap"],
        "model": "llama.cpp/owner/qwen",
        "cost": "cheap (free/budget)",
        "guardrails": "permissive",
        "rank": 1
      },
      "grok-4.6": {
        "role": "hard debugging and planning",
        "classes": ["frontier", "intelligent"],
        "model": "xai/grok-4.6",
        "cost": "paid (frontier)",
        "guardrails": "strict — may decline policy-sensitive or high-risk security work; ordinary decompile-to-understand is fine",
        "rank": 1
      }
    }
  },
  "model": "jev-latest",
  "questions": {
    "rescuer": {
      "type": "choice",
      "instructions": "Pick the model in `models` whose role and classes best fit `question` (with `context` and `files`). The standing goal is to spend as few LLM tokens as possible: choose the cheapest model whose capabilities cover the need (classes cheap/fast/local first), and pick intelligent/frontier only when the problem genuinely demands it. Match capability tags to the question — e.g. a question about an image or screenshot needs a vision-classed model. Avoid strict-guardrail models when the content looks likely to trigger a refusal — NSFW/adult/sexual content (including image captions), or blackhat-borderline work (exploit payloads, protection bypass, malware, unauthorized access). Ordinary reverse engineering (decompile/disassemble to understand a binary, defensive analysis) stays on aligned models. Prefer an abliterated-class one only for the refusal cases; among those, prefer one also classed local over a hosted abliterated fallback. When several fit equally, prefer the lower `rank` (1 = first choice).",
      "criteria": {
        "qwen-27b": "local coding and research",
        "grok-4.6": "hard debugging and planning"
      }
    }
  }
}
```

The dynamic values above are examples. The fields and classifier
instruction match the runtime payload. `question` stops at 1,200
characters; `context` stops at 400.

</details>

```json
{
  "model": "jev-1.13",
  "answers": {
    "rescuer": {
      "type": "choice",
      "choice": "qwen-27b",
      "probabilities": {
        "qwen-27b": 0.78,
        "grok-4.6": 0.22
      },
      "confidence": 0.78
    }
  }
}
```

TypeSafe returns the whole distribution. The choice must still exist in
the available pool and meet `judge.minConfidence`.

---

## How do you describe a model?

```jsonc
{
  "models": {
    "grok-4.6": {
      "provider": "xai",
      "model": "grok-4.6",
      "role": "hard debugging and planning",
      "classes": ["frontier", "intelligent"],
      "rank": 1
    }
  }
}
```

| Field | What routing learns |
| --- | --- |
| `role` | When this model helps |
| `classes` | Which handles and capabilities it owns |
| `rank` | How it wins ties |
| `prescreen` | Whether strict-model limits matter |

Class `default` marks the no-target fallback. Without one, the best-ranked
available entry wins.

---

## What if the target is offline?

Pi health-checks `llama.cpp` entries. It assumes cloud entries are
reachable because probing them would spend credentials or quota.

An explicit offline target stops with its reason. **Routing never swaps
your explicit choice behind your back.**

The request log keeps the proposal, final model, selection source,
confidence, and availability exclusions.

Implementation: `lib/config.ts`, `lib/availability.ts`, and
`extensions/advisor.ts`.

Next: [why Pi asks for approval](consultation-approval.md).
