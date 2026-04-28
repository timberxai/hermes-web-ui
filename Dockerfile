# hermes-admin image — single-container hermes agent + web-ui + Caddy + lark-cli.
#
# Layout inside container:
#   8642  hermes gateway        (HTTP, mapped to host 20000+)
#   6060  hermes-web-ui node    (HTTP, internal)
#   9119  Caddy TLS → 6060      (mapped to host 21000+, HTTPS)
#
# Started by /opt/start.sh: gateway, then node, then exec caddy in foreground.
# Container lifecycle is tied to Caddy.

ARG BASE_IMAGE=nousresearch/hermes-agent:latest
FROM ${BASE_IMAGE}

USER root

# System deps + Caddy 2.9.1 + Node 23.11 + tini.
# Node is fetched from nodejs.org as a static tarball so we don't depend on
# whatever Node version (if any) the base image happens to ship.
RUN apt-get update -qq && apt-get install -y --no-install-recommends \
      ca-certificates curl tar tini xz-utils python3 make g++ \
 && curl -fsSL "https://github.com/caddyserver/caddy/releases/download/v2.9.1/caddy_2.9.1_linux_amd64.tar.gz" \
    | tar xz -C /usr/local/bin caddy \
 && chmod +x /usr/local/bin/caddy \
 && curl -fsSL "https://nodejs.org/dist/v23.11.0/node-v23.11.0-linux-x64.tar.xz" \
    | tar xJ -C /usr/local --strip-components=1 \
 && apt-get clean && rm -rf /var/lib/apt/lists/*

# lark-cli for Feishu doc operations from inside the agent.
RUN npm install -g @larksuite/cli

# Build hermes-web-ui from this repo's source. Native modules (node-pty etc.)
# need python3/make/g++ which are installed above.
WORKDIR /app
COPY package*.json ./
RUN npm install --ignore-scripts
COPY . .
RUN npm run build && npm prune --omit=dev

# config.dataDir is hardcoded to /app/dist/data by upstream. Sticky-bit
# world-writable so any UID the orchestrator runs us as can mkdir subdirs
# (closeclaw runs containers as UID 1011 with HOME=/opt/data).
RUN mkdir -p /app/dist/data && chmod 1777 /app/dist/data

ENV NODE_ENV=production

COPY docker/caddy.Caddyfile /opt/caddy.Caddyfile
COPY docker/start.sh /opt/start.sh
RUN chmod +x /opt/start.sh

EXPOSE 6060 9119 8642

ENTRYPOINT ["tini", "--", "/opt/start.sh"]
CMD []
