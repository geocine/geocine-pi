# Docker jail (optional)

```bash
docker build -t geocine-consult docker
```

Only needed for `jail: "docker"` models. `jail: "staged"` already
gives the token firewall (the consulted model's cwd contains only staged
files) without a container — docker adds process/filesystem isolation on
top for models you trust less.

The staged snapshot is mounted at `/work` inside the container; the
consulted model gets read-only tools and sees nothing else.

## Auth

`staged`/`none` consults run as pi processes on the host and inherit
`~/.pi/agent/auth.json` — OAuth providers (xai, openai-codex, ...) just
work.

The docker jail does **not** get host auth; use the model's `envKeys`
to forward API keys into the container, or prefer `staged` for OAuth
providers.
