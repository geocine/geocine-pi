# Docker jail (optional)

```bash
docker build -t geocine-consult docker
```

Only needed for `jail: "docker"` consultants. `jail: "staged"` already
gives the token firewall (the consultant's cwd contains only staged files)
without a container — docker adds process/filesystem isolation on top for
consultants you trust less.

The staged snapshot is mounted at `/work` inside the container; the
consultant gets read-only tools and sees nothing else.

## Auth

`staged`/`none` consultants run as pi processes on the host and inherit
`~/.pi/agent/auth.json` — OAuth providers (xai, openai-codex, ...) just
work.

The docker jail does **not** get host auth; use the consultant's `envKeys`
to forward API keys into the container, or prefer `staged` for OAuth
consultants.
