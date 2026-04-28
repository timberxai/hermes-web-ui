#!/bin/sh
# Single-container startup: hermes gateway (8642) + hermes-web-ui node (6060)
# + Caddy TLS (9119 → 6060). Container lifecycle is tied to Caddy.
set -e

HERMES=/opt/hermes/.venv/bin/hermes

# 1. Hermes gateway — HTTP API on 8642
"$HERMES" gateway run &

# Give gateway a moment to bind 8642 before web-ui tries to talk to it.
sleep 3

# 2. hermes-web-ui — HTTP node server on 6060
node /app/dist/server/index.js &

# Brief delay so Caddy doesn't proxy to a port that hasn't bound yet.
sleep 1

# 3. Caddy — TLS on 9119, foreground (PID 1 via tini)
exec caddy run --config /opt/caddy.Caddyfile
