# ybrain — company knowledge MCP server (Bun + TypeScript).
# Reads/writes a single Git data repo via a local clone.

FROM oven/bun:1-debian

RUN apt-get update \
    && apt-get install -y --no-install-recommends git ca-certificates \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /opt/ybrain
COPY package.json bun.lock* tsconfig.json ./
RUN bun install --frozen-lockfile --production
COPY src/ src/

# The data repo is cloned here at startup; mount a volume for persistence.
RUN git config --global --add safe.directory '*' \
    && mkdir -p /data

ENV YBRAIN_PORT=8080 YBRAIN_DATA_DIR=/data/repo
EXPOSE 8080

ENTRYPOINT ["bun", "run", "/opt/ybrain/src/server.ts"]
