# Hermes Web UI — 独立容器（不 FROM hermes-agent）
#
# 本 Dockerfile 不再继承 hermes-agent 镜像，改为纯 Node 23 base。
# hermes 二进制与 ~/.hermes 数据目录通过 volume 在运行时由 hermes-agent 容器注入：
#   -v hermes-agent-src:/opt/hermes
#   -v hermes-data:/home/agent/.hermes
# 配合 env HERMES_GATEWAY_MANAGED_EXTERNALLY=1 禁用本容器内 spawn gateway。
#
# 优点：web-ui 镜像版本与 hermes-agent 镜像版本完全解耦，互不影响升级节奏。

FROM node:23-bookworm-slim AS builder

RUN apt-get update && apt-get install -y --no-install-recommends \
    ca-certificates \
    curl \
    python3 \
    make \
    g++ \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY package*.json ./
RUN npm install --ignore-scripts

COPY . .
RUN npm run build

# ─── Runtime image ────────────────────────────────────────────
FROM node:23-bookworm-slim AS runtime

# node-pty 需要 libc / stdc++ 在运行时可用；slim 镜像已含
# Caddy 用于 TLS 终止（6443 → 6060），与 hermes-admin 的 dashboard 同款。
RUN apt-get update && apt-get install -y --no-install-recommends \
    ca-certificates \
    curl \
    tar \
    tini \
    && curl -fsSL "https://github.com/caddyserver/caddy/releases/download/v2.9.1/caddy_2.9.1_linux_amd64.tar.gz" \
       | tar xz -C /usr/local/bin caddy \
    && chmod +x /usr/local/bin/caddy \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY --from=builder /app/package*.json ./
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/dist ./dist
COPY --from=builder /app/bin ./bin

RUN npm prune --omit=dev

ENV NODE_ENV=production
ENV HOME=/home/agent
ENV HERMES_HOME=/home/agent/.hermes

# Both /home/agent (HOME → server.log, .hermes-web-ui/) and /app/dist/data
# (config.dataDir, hardcoded by upstream) must be writable by whatever UID
# the orchestrator runs us as. Sticky-bit world-writable mirrors /tmp semantics
# so arbitrary UIDs can mkdir subdirs without us baking in a fixed user.
RUN mkdir -p /home/agent /app/dist/data && chmod 1777 /home/agent /app/dist/data
# hermes CLI 由 /opt/hermes volume 注入（agent 容器共享）
ENV HERMES_BIN=/opt/hermes/.venv/bin/hermes
# gateway 不由本容器管理
ENV HERMES_GATEWAY_MANAGED_EXTERNALLY=1
# 默认上游 gateway 位置（docker-compose 场景下指向 hermes-agent 服务）
ENV UPSTREAM=http://hermes-agent:8642

COPY docker/caddy.Caddyfile /opt/caddy.Caddyfile
COPY docker/start.sh /opt/start.sh
RUN chmod +x /opt/start.sh

EXPOSE 6060 6443

ENTRYPOINT ["tini", "--", "/opt/start.sh"]
CMD []
