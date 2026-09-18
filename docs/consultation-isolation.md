# What can the consultant read?

Read-only isn't the same as bounded. A model that can read your whole
repo can still consume context and see files you never meant to send.

**`staged` exposes the files you named. `none` exposes the live workspace.
`auto` picks one per consult.**

## Where does the child run?

```mermaid
sequenceDiagram
    participant A as Advisor
    participant S as Staging
    participant P as Pre-screen
    participant J as Jail sentry
    participant C as Consultant
    participant L as Log

    alt jail is staged
        A->>S: Copy requested files or ranges
        S->>L: Manifest + errors + bytes
        opt Pre-screen is enabled
            S->>P: Bounded staged content
            P-->>A: Continue or stop
        end
        alt Continue
            A->>J: Start child in temporary root
            J->>C: Brief + read-only tools
            J-->>L: Blocked escape attempts
        else Stop
            A->>L: Pre-screen outcome
        end
    else jail is none
        A->>C: Run in live workspace
    end

    opt Child ran
        C-->>A: One advisory response
        A->>L: Usage + files read
    end
```

Routing answers *who*. Approval answers *whether*. Isolation answers
*what that model can see*.

---

## What does `staged` copy?

| Input | What enters the temporary workspace |
| --- | --- |
| `+src/file.ts` | The whole file with its relative path |
| `+src/file.ts:12-80` | That line range |
| Path outside the workspace | A file flattened to its basename |
| File over 256 KiB | A truncated file plus a staging error |
| Missing or unreadable file | Nothing, plus a recorded error |
| No successful files | A question-only run with no tools |

The brief tells the consultant that this temporary directory is the
*entire* workspace. The sentry blocks and records reads outside it.

---

## When should you use `none`?

`jail: "none"` skips staging and runs in your active workspace. Tools stay
read-only, but paths aren't bounded.

You might think read-only makes this equally safe. It prevents writes; it
doesn't prevent broad reads.

Use live mode only when that wider boundary is deliberate. It also skips
pre-screening because there is no staged payload.

---

## When should you use `auto`?

The boundary exists for one flow: policy-sensitive work on an abliterated
lease consulting an *aligned* model. Staging lets that consultant take the
chosen excerpts and advise without seeing — or refusing over — the rest.
Ordinary coding consults gain nothing from the copy step; they just lose
the live workspace.

`jail: "auto"` encodes exactly that, resolved per consult:

1. **Refusal-sensitive session** (an active abliterated lease, or the last
   task scored refusal-high) → `staged`, deterministically. No judge call —
   triage already knows.
2. **Abliterated-class target** → `none`. It is the model such work is
   for; there is nothing to shield it from.
3. **Everything else** → the fabric's `jail` node scores the question and
   file names for sensitive content. Confidently bland → `none` (the live
   workspace is more useful to the consultant). Sensitive, unsure, an
   uncalibrated answer, or no judge at all → `staged`.

The judge can only ever *loosen* the boundary, never hold it: every
uncertain path fails closed to `staged`, and the naive-llm fallback tier is
never allowed to loosen (calibrated answers only — the same containment
rule the context keeper applies to memory injections and digest drops).
The decision and its provenance (`jailBy`, `jailSensitiveP`) land on the
`consult_request` record.

---

## What does the child get?

The consultant runs in a separate, sessionless Pi process with:

- the selected provider, model, and thinking level;
- one bounded brief;
- read-only tools when a workspace exists;
- a 15-minute timeout;
- one `SEVERITY`, `ADVICE`, and optional `PLAN` response.

It returns one advisory note. It never inherits the main tool loop.

---

## How do you choose the boundary?

```jsonc
{
  "models": {
    "reviewer": {
      "provider": "xai",
      "model": "grok-4.6",
      "jail": "staged",
      "thinking": "high",
      "notes": "Focus on correctness and scope."
    }
  }
}
```

Keep `staged` unless you want the consultant to inspect the wider
workspace.

The log keeps requested paths, copied paths, line ranges, bytes, errors,
actual reads, and blocked escapes.

Implementation: `extensions/advisor.ts`, `lib/jail-sentry.ts`, and
`lib/pi-exec.ts`.

Next: [what happens before a strict consultant launches](consultation-prescreen.md).
