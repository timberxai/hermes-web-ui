#!/bin/sh
# Start node web-ui server (HTTP on 6060) in background, then run Caddy in
# foreground (TLS on 6443 → 6060). Container lifecycle is tied to Caddy,
# matching the hermes-admin gateway/dashboard layout.
set -e

node /app/dist/server/index.js &

# Brief delay so Caddy doesn't proxy to a port that hasn't bound yet.
sleep 1

exec caddy run --config /opt/caddy.Caddyfile
