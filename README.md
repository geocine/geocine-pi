# geocine-pi

Most coding agents make one model do everything. geocine-pi keeps your
chosen worker in charge, then brings in routing, memory, or a specialist
only when the work earns it.

**Your selected worker owns the task from start to finish.**

## What's in the loop?

```mermaid
flowchart LR
    IN[Your task] --> P[Pi session]
    P --> D{Decision fabric}
    D -->|keep / hop / dwell / return| W[Selected worker<br/>owns the task]
    W <-->|calls / results| T[Tools + workspace]
    W --> OUT[Your result]

    C[(Context keeper)] -->|relevant history| P
    P -->|new evidence| C

    W -->|bounded question| S[Specialist]
    S -->|advice only| W

    D -. guard / progress / verify .-> W
    P --> L[(Decision log)]
    D --> L
```

Read the solid line from left to right: task, route, worker, result. The
dotted line shows oversight around the worker.

Context restores evidence; a specialist answers one bounded question.
Neither takes ownership from the selected worker.

---

## What happens after you press Enter?

```mermaid
sequenceDiagram
    actor U as You
    participant P as Pi
    participant D as Decision fabric
    participant W as Worker
    participant S as Specialist
    participant C as Context + logs

    U->>P: Task
    P->>D: Route
    D-->>P: Keep, hop, dwell, or return
    P->>C: Recover useful history
    C-->>P: Working context
    P->>W: Task + context

    loop Work
        W->>P: Tool call
        P->>D: Check call + progress
        D-->>P: Continue, correct, or consult
        P-->>W: Result or feedback
    end

    opt A second opinion earns its cost
        P->>S: Approved bounded brief
        S-->>W: Advice
    end

    W-->>P: Result
    P->>D: Verify
    P->>C: Preserve evidence
    P-->>U: Result or status
```

**A model hop changes who runs the turn. It doesn't hand over ownership.**

---

## How do you run it?

```bash
pi install /path/to/geocine-pi
cp geocine.example.json ~/.pi/agent/geocine.json
export TYPESAFE_API_KEY=...
pi
```

```text
/geocine
/consult @frontier +docs/outline.md is this topic order right?
```

`/geocine` opens the control hub. `/consult` asks one configured model one
bounded question.

---

## Where should you read next?

Start with the [documentation map](docs/flows.md) and pick the question
that matches what surprised you.

If you already know the setting, jump to the
[configuration reference](docs/configuration.md).
