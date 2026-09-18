# What happens around the reasoning loop?

The worker shouldn't have to reason around terminal escape codes, rate
windows, cache affinity, or a stopwatch.

**Small boundary adapters handle those chores without changing the worker's plan.**

## Why did shell output change?

```mermaid
sequenceDiagram
    participant S as Shell
    participant B as Bash repair
    participant W as Worker

    S-->>B: Raw result
    B->>B: Strip escapes + resolve carriage returns
    opt Known command failed
        B->>B: Prepend short failure summary
    end
    B-->>W: Summary + sanitized original
```

Go, Cargo, pytest, Python tracebacks, and Node get compact failure
summaries. Successful or unknown output only gets sanitized.

---

## Why did a Baseten request wait?

```mermaid
sequenceDiagram
    participant P as Pi
    participant L as Baseten limiter
    participant B as Baseten

    P->>L: Before request
    L->>L: Check sliding RPM + TPM windows
    L->>B: Release inside budget
    alt Success
        B-->>P: Response
        P->>L: Clear server hold
    else 429
        B-->>P: Retry-After
        P->>L: Record server hold
        L->>B: Release after reset
    end
```

The defaults leave headroom below the basic limits:
`BASETEN_RPM=14` and `BASETEN_TPM=90000`.

Environment variables replace both values.

---

## What does the timer count?

```mermaid
sequenceDiagram
    participant P as Pi
    participant T as Worked timer
    actor U as You

    P->>T: Agent starts
    T-->>U: Live elapsed time
    opt Pi asks you
        P->>T: Pause
        U-->>P: Answer
        P->>T: Resume
    end
    P->>T: Agent settles
    T-->>U: Duration + turns + tool calls
```

Human wait time doesn't count as agent work. Runs under five seconds
update the footer without adding a notification.

---

## Can a hosted hop keep its prefix warm?

```mermaid
sequenceDiagram
    participant P as Pi session
    participant H as Cache-key adapter
    participant A as Hosted permissive provider
    participant C as Provider prefix cache

    P->>H: Request
    H->>A: Stable prompt_cache_key
    A->>C: Look up session prefix
    C-->>A: Hit or miss
    A-->>P: Response + cache usage
```

The stable key improves backend affinity for `abliteration-ai`. It can't
move cache state between different models.

**A cache key improves your chance of a hit; it doesn't make caches portable.**

---

## What can `/geocine` change?

```mermaid
sequenceDiagram
    actor U as You
    participant M as /geocine
    participant C as Config
    participant L as Logs

    U->>M: Open hub
    M->>C: Read live settings
    M->>L: Read status + counts
    M-->>U: Models, gates, context, judge, lessons
    opt You change a setting
        U->>M: Select action
        M->>C: Validate + persist
    end
```

Most config is reread on events, so menu changes don't need a reload.

---

## Why aren't these one subsystem?

| Adapter | Boundary it owns |
| --- | --- |
| `bash-repair` | Shell result entering context |
| `baseten-limits` | Baseten request timing |
| `worked-timer` | Interactive elapsed time |
| `abliteration-cache` | Hosted prefix affinity |
| `geocine-menu` | Your config and status UI |

They sit on unrelated boundaries. Combining them would couple provider,
UI, and transcript behavior without helping the worker.

Implementation: `extensions/bash-repair.ts`,
`extensions/baseten-limits.ts`, `extensions/worked-timer.ts`,
`extensions/abliteration-cache.ts`, and `extensions/geocine-menu.ts`.

Next: [inspect every setting](configuration.md).
