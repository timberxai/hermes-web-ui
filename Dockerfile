# hermes-web-ui sidecar image — runs the chat UI (node server + Caddy) as
# a sidecar to a hermes-agent container. Inherits from hermes-agent so the
# `hermes` binary is present in $PATH (needed by hermes-cli.ts for the CLI
# fallback and the sqlite readers that hit state.db directly).
#
# Closeclaw pairs this with a hermes-{user} container and mounts the same
# user data directory (/home/agent/.hermes) into both, so sessions.db /
# .env / skills are shared. No gateway is spawned here —
# HERMES_GATEWAY_MANAGED_EXTERNALLY=1 keeps the web-ui deferring to the
# gateway in the sibling container (reachable via UPSTREAM env).
#
# Layout inside container:
#   6060  node web-ui        (HTTP, internal)
#   6443  Caddy TLS → 6060   (mapped to host webui_port, HTTPS)

ARG BASE_IMAGE=nousresearch/hermes-agent:latest
FROM ${BASE_IMAGE}

USER root

# Node 23.11 + Caddy 2.9.1 + tini + native-build deps for node-pty etc.
RUN apt-get update -qq && apt-get install -y --no-install-recommends \
      ca-certificates curl tar tini xz-utils python3 make g++ \
 && curl -fsSL "https://github.com/caddyserver/caddy/releases/download/v2.9.1/caddy_2.9.1_linux_amd64.tar.gz" \
    | tar xz -C /usr/local/bin caddy \
 && chmod +x /usr/local/bin/caddy \
 && curl -fsSL "https://nodejs.org/dist/v23.11.0/node-v23.11.0-linux-x64.tar.xz" \
    | tar xJ -C /usr/local --strip-components=1 \
 && apt-get clean && rm -rf /var/lib/apt/lists/*

# Build hermes-web-ui from this repo's source.
WORKDIR /app
COPY package*.json ./
RUN npm install --ignore-scripts
COPY . .
RUN npm run build && npm prune --omit=dev

# config.dataDir is hardcoded to /app/dist/data by upstream. Sticky-bit
# world-writable so any UID the orchestrator runs us as can mkdir subdirs.
RUN mkdir -p /app/dist/data && chmod 1777 /app/dist/data

ENV NODE_ENV=production

COPY docker/caddy.Caddyfile /opt/caddy.Caddyfile
COPY docker/start.sh /opt/start.sh
RUN chmod +x /opt/start.sh

EXPOSE 6060 6443

ENTRYPOINT ["tini", "--", "/opt/start.sh"]
CMD []
