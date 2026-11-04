# Why did Pi ask before consulting?

A consultation can spend tokens and expose staged files. The worker
shouldn't get to spend either without a rule you chose.

**TypeSafe may approve. It never denies for you.**

## Who makes the call?

```mermaid
sequenceDiagram
    participant W as Worker
    participant G as Approval gate
    participant J as TypeSafe
    actor U as You
    participant C as Consultation

    W->>G: Model + question + files

    alt Model or global config says auto
        G->>C: Run
    else Judge mode
        G->>J: Is this worth running?
        alt Probability meets threshold
            J-->>G: Approve
            G->>C: Run
        else Lower, missing, or failed
            G->>U: Ask
        end
    else Ask mode
        G->>U: Ask
    end

    opt You were asked
        alt Approve
            U-->>G: Use proposed model
            G->>C: Run
        else Override
            U-->>G: Pick any model from pi's list
            opt From now on
                G->>G: Pin it for tasks like this
            end
            G->>C: Run override
        else Something else
            U-->>W: Do this instead (your text)
        else Persist
            U-->>G: Always this model or all models
            G->>C: Save + run
        else Deny or close
            U-->>W: Keep working alone
        end
    end
```

| Mode | What happens |
| --- | --- |
| `ask` | You approve, override, deny, or persist a choice |
| `judge` | A strong yes runs; every other outcome asks you |
| `auto` | Worker-requested consults run without a prompt |
| model `autoApprove: true` | That model skips the prompt |
| your `/consult` command | Runs directly |

Headless runs proceed because there is no UI to answer. Starting that run
counts as prior approval.

---

## What does TypeSafe classify?

```mermaid
flowchart LR
    S[Question + proposed model + files] --> J[approve noul]
    J --> P[Probability of yes]
    P -->|meets approveThreshold| R[Run]
    P -->|lower or missing| U[Ask you]
```

<details>
<summary>Open the actual TypeSafe POST body</summary>

```jsonc
{
  "state": {
    "question": "Should we change the cache key strategy?",
    "model": "grok-4.6",
    "role": "hard debugging and planning",
    "classes": ["frontier", "intelligent"],
    "jail": "staged",
    "proposed_by": "judge",
    "staged_files": ["lib/cache.ts", "test/cache.test.ts"]
  },
  "model": "jev-latest",
  "questions": {
    "approve": {
      "type": "noul",
      "instructions": "The local worker wants to consult `model` (see `role`, `classes`) with `question`, staging `staged_files`. Should this run WITHOUT asking the user? Approve when the question is specific and substantive, the staged files are minimal and relevant, and the model's classes fit the need — cheap/local/fast consults need little justification, while frontier/intelligent-class ones must look genuinely beyond the local worker. When in doubt, ask.",
      "criteria": {
        "true": "Clearly justified and well-routed — run it without interrupting the user",
        "false": "Doubtful: vague question, over-staging, or cost/class mismatch — ask the user"
      }
    }
  }
}
```

The values are examples. The fields, classifier question, and criteria
match the runtime payload. `question` stops at 600 characters;
`staged_files` stops at twenty.

</details>

```json
{
  "model": "jev-1.13",
  "answers": {
    "approve": {
      "type": "noul",
      "noul": 0.91
    }
  }
}
```

`noul` means “probability of true.” If it misses
`approval.approveThreshold`, Pi asks you.

When it asks you, your answer becomes a label. The node's probability is
logged next to your yes/no, and `/calibration` shows the join: **a wide
gap between "mean probability when you said yes" and "when you said no"
means the node ranks well and the threshold can come down.** No gap
means it can't tell — the threshold only buys silence.

---

## How do you set the rule?

```jsonc
{
  "approval": {
    "consultTool": "ask",
    "approveThreshold": 0.85
  }
}
```

Set `models.<name>.autoApprove` when one model has earned a permanent
exception. Choosing a persistent option in the dialog writes the global
config immediately.

---

## What happens when you pick another model?

**Pick another** lists your registered rescuers first, then every other
model pi's own picker offers, marked *unregistered*. An unregistered pick
runs with `jail: "staged"`, the safe default for a model you haven't
classified.

Then one question: **use it for tasks like this from now on?**

| Answer | What happens |
| --- | --- |
| Just this once | It runs. The override is logged as usual. |
| Yes, from now on | You name the kind of task (Enter keeps the question). The pin lands in global `geocine.json` under `routing.pinned`. An unregistered model is registered too: that task becomes its role, and its classes come from pi's catalog (below). |

Classes for a newly registered model are read from facts, never guessed:

| Class | From |
| --- | --- |
| `vision` | the model accepts image input |
| `local` | provider is `llama.cpp`, `lmstudio`, or `ollama` |
| `cheap` | local, a `rescue.localProviders` provider, or priced at or under $0.50 in / $2.50 out per Mtok |

`frontier`, `intelligent`, and `abliterated` can't be derived. The model
stays aligned and staged until you add them in `geocine.json`.

Next time the router sees the same kind of task, it proposes the pinned
model. You still approve. A pin outranks cost, rank, and history, but not
a missing capability or a refusal-prone strict model. `/models` lists your
pins; delete one from `routing.pinned` to unpin.

Pins need the route node, so they apply when the worker leaves `model`
unset. A class the worker names explicitly still stands.

`/consult @provider/model` takes any model from pi's list the same way.

---

## What if you want something else entirely?

**Something else…** skips the consult and asks what the worker should
do instead. Your text goes back to the worker as the tool result. It's
logged as `user_instead`, which doesn't count against the proposed model.

---

## What gets learned?

A denial is logged even though no consultant ran. An override becomes a
direct correction to the routing decision.

Those human labels are stronger than a classifier guess.

Implementation: `extensions/advisor.ts`.

Next: [what the approved model can read](consultation-isolation.md).
