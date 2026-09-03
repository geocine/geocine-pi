# geocine-consult: docker jail for consultations (jail: "docker").
#
# Pattern vendored from the geobench agent container: the container sees ONLY
# the staged snapshot (mounted at /work) — no repo, no host home, nothing to
# leak and nothing extra to read. This is a context firewall first (bounds
# the consultant's input token spend) and a security boundary second.
#
# Build:  docker build -t geocine-consult .
# The advisor extension mounts the staging dir at /work and runs:
#   pi --mode json -p --no-session --provider ... --model ... "<briefing>"
# Provider API keys are forwarded per-consultant via envKeys in geocine.json.

FROM node:22-slim

RUN apt-get update \
	&& apt-get install -y --no-install-recommends git ripgrep ca-certificates \
	&& rm -rf /var/lib/apt/lists/*

RUN npm install -g @earendil-works/pi-coding-agent

RUN useradd -m -s /bin/bash agent
USER agent
WORKDIR /work

ENTRYPOINT []
CMD ["pi", "--help"]
