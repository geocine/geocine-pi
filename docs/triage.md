# Why did the active model change?

A model hop can avoid a refusal, but it burns the current cache. Returning
after one turn can burn it again.

**Triage routes the first turn, then leases that route until the topic has
really changed.**

## Where does a new task start?

```mermaid
sequenceDiagram
    actor U as You
    participant P as Pi
    participant T as Triage
    participant J as TypeSafe
    participant W as Picker worker
    participant A as Permissive worker

    U->>P: New task
    P->>T: Input
    T->>J: Hardness + refusal risk + route

    alt High refusal risk and local target exists
        J-->>T: Use permissive route
        T->>P: Select local-first target
        P->>A: Run task
    else Task is hard for the picker
        J-->>T: Plan first or frontier
        T-->>W: Suggest early consultation
        P->>W: Run task
    else Local, uncertain, failed, or no answer
        T-->>P: Keep picker
        P->>W: Run task
    end
```

Hardness and refusal risk are different questions. A hard ordinary task
can stay with an aligned worker and ask for specialist advice.

---

## Should the next turn stay there?

```mermaid
sequenceDiagram
    actor U as You
    participant P as Pi
    participant T as Triage
    participant J as TypeSafe
    participant A as Permissive worker
    participant W as Original worker

    U->>P: Next message
    P->>T: Message + lease history
    T->>J: Root task + prior exchange + message

    alt Continuation or real ambiguity
        J-->>T: Dwell
        P->>A: Continue warm
    else Independent benign task
        J-->>T: Return
        T->>P: Restore original model
        P->>W: Run new task
    else Timeout, low confidence, or no judge
        T-->>P: Dwell
        P->>A: Avoid another cold switch
    end
```

A pronoun, revision, short follow-up, or another sensitive request stays
on the lease. A clear new benign task returns.

You might think uncertainty should restore the original model. That would
turn vague follow-ups into cache-destroying ping-pong, so uncertainty
dwells.

A manual model choice cancels the lease immediately.

---

## What does a hop cost?

```mermaid
sequenceDiagram
    participant W as Original model
    participant CW as Original cache
    participant A as Permissive model
    participant CA as Permissive cache

    W->>CW: Build prefix
    Note over CW,CA: KV state can't move between models
    Note over W,CW: A one-slot server may evict this cache
    A->>CA: Build a new prefix
    CA-->>A: Dwell turns reuse it
    Note over W,A: Returning may require full prefill
```

The lease can't save the cache across the first hop. It prevents repeated
cold switches after that hop.

---

## Which rule wins?

| Situation | Action |
| --- | --- |
| Ordinary analysis or routine work | Keep the aligned picker |
| High refusal risk on a strict cheap worker | Hop to the first available permissive model |
| Follow-up, revision, pronoun, or ellipsis | Dwell |
| Another policy-sensitive request | Dwell |
| Relationship is uncertain | Dwell |
| New benign topic is independent | Return |
| You select a model | Cancel the lease |

Permissive candidates sort local first, then by `rank`. Hosted models are
fallbacks.

---

## Why doesn't the hop ask first?

Triage only routes cheap workers. A cheap worker is a budget pick, so
swapping it for a permissive model of the same class doesn't override a
deliberate choice. **Cheap workers hop without a prompt; any other worker
is asked first.**

The outcome gate follows the same rule when a refusal slips through: a
cheap worker hops and retries automatically; a model you picked on purpose
gets an approval prompt, and headless runs don't hop it at all. See
[the refusal flow](runtime-control.md#what-if-the-worker-refuses).

---

## How do you tune it?

```jsonc
{
  "triage": {
    "enabled": true
  }
}
```

| Setting | What it changes |
| --- | --- |
| `triage.enabled` | Task-start routing and lease judgments |
| class `abliterated` | Marks a permissive candidate |
| class `local` | Moves that candidate ahead of hosted ones |
| model `rank` | Breaks ties inside each group |

`triage.enabled: false` stops new routing. A lease the outcome gate opened
still gets dwell or return decisions, so the session can find its way
back. Mid-task consult suggestions belong to the watchdog
(`watchdog.escalateThreshold`).

---

## What can you inspect later?

`TriageRecord.safetyAction` keeps `hop`, `dwell`, or `return`.
`safetyConfidence` keeps the transition confidence.

The judge sees the root task and the previous exchange, not an isolated
fragment. `message_end` captures the assistant answer needed for the next
lease decision.

Implementation: `extensions/triage.ts`, `lib/config.ts`, and
`lib/consult-log.ts`.

Next: [how local cache behaves during that hop](local-qwen.md).
