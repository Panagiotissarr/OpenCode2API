# Pinned to the 2026-10-20 security release: the floating lts tag lagged
# behind it, leaving the image exposed to CVE-2026-105482/105483/106069/111497.
FROM node:24.22.1-slim

RUN apt-get update && apt-get install -y --no-install-recommends \
    git \
    curl \
    ca-certificates \
    && dpkgArch="$(dpkg --print-architecture | awk -F- '{ print $NF }')" \
    && curl -Lo /usr/local/bin/gosu "https://github.com/tianon/gosu/releases/download/1.17/gosu-$dpkgArch" \
    && chmod +x /usr/local/bin/gosu \
    && gosu --version \
    && rm -rf /var/lib/apt/lists/*

# opencode-ai 2.x moved the server API under /api/* and is incompatible with
# @opencode-ai/sdk 1.x used by this proxy. Pin the newest 1.x release (1.19.0,
# verified against the OpenCode Zen free tier 2026-10-15).
RUN npm install -g opencode-ai@1.19.0

RUN mkdir -p /home/node/.local/share/opencode \
    && mkdir -p /home/node/.config/opencode \
    && mkdir -p /home/node/project \
    && chown -R node:node /home/node

COPY entrypoint.sh /usr/local/bin/entrypoint.sh
RUN chmod +x /usr/local/bin/entrypoint.sh

WORKDIR /home/node/project

COPY package*.json ./
RUN npm install --production

COPY . .

EXPOSE 10000

ENV OPENCODE_SERVER_PASSWORD=
ENV API_KEY=
ENV BIND_HOST=0.0.0.0
ENV OPENCODE_DISABLE_TOOLS=true
ENV OPENCODE_USE_ISOLATED_HOME=false
ENV OPENCODE_PROXY_DEBUG=false
ENV OPENCODE_PROXY_OMIT_SYSTEM_PROMPT=false
ENV OPENCODE_PROXY_AUTO_CLEANUP_CONVERSATIONS=false
ENV OPENCODE_PROXY_CLEANUP_INTERVAL_MS=43200000
ENV OPENCODE_PROXY_CLEANUP_MAX_AGE_MS=86400000
ENV OPENCODE_PROXY_REQUEST_TIMEOUT_MS=180000
ENV OPENCODE_PROXY_MANAGE_BACKEND=true

ENTRYPOINT ["/usr/local/bin/entrypoint.sh"]
CMD ["node", "index.js"]
