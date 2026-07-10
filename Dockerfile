# Warren container image (SPEC §10.3).
#
# Two-stage build:
#   1. ui-builder — build the React/Vite SPA into src/ui/dist.
#   2. runtime    — bun + bwrap + uidmap, warren source, burrow itself
#                   plus the bundled os-eco CLIs warren shells out to.

# ---------- stage 1: build the UI ----------
FROM oven/bun:1.2 AS ui-builder
WORKDIR /ui-build
COPY src/ui/package.json src/ui/bun.lock src/ui/tsconfig.json ./
COPY src/ui/tsconfig.app.json src/ui/tsconfig.node.json ./
COPY src/ui/vite.config.ts src/ui/index.html ./
COPY src/ui/src ./src
RUN bun install --frozen-lockfile
RUN bun run build

# ---------- stage 2: runtime ----------
FROM oven/bun:1.2

RUN apt-get update \
    && apt-get install -y --no-install-recommends \
        bubblewrap \
        uidmap \
        git \
        ca-certificates \
        curl \
        gnupg \
        netcat-openbsd \
    && curl -fsSL https://deb.nodesource.com/setup_22.x | bash - \
    && apt-get install -y --no-install-recommends nodejs \
    && rm -rf /var/lib/apt/lists/*

# Pin burrow to a specific commit so a normal `docker build` re-pulls the
# fork on every commit bump. Without the ref, the layer is cacheable across
# forks pointing at the same head SHA.
ARG BURROW_REF=43458446ce89ebd009eaf82ef0f44bf4d1ef973c

ENV BUN_INSTALL=/usr/local
RUN bun install -g \
    "github:yegorske50/burrow#${BURROW_REF}" \
    @os-eco/canopy-cli@0.2.4 \
    @os-eco/seeds-cli@0.5.13 \
    @os-eco/mulch-cli@0.10.7 \
    @os-eco/sapling-cli@0.3.2 \
    @os-eco/plot-cli@0.4.0 \
    @anthropic-ai/claude-code@2.1.150 \
    @earendil-works/pi-coding-agent@0.77.0 \
    pnpm@11.1.2

# bun install -g skips lifecycle scripts by default, so claude-code's
# postinstall (which downloads the platform-native `claude` binary) doesn't
# run. Invoke it explicitly so /usr/local/bin/claude is wired up before
# burrow tries to spawn it.
RUN bun run /usr/local/install/global/node_modules/@anthropic-ai/claude-code/install.cjs

# Pi's dist/cli.js ships with `#!/usr/bin/env node`. We replace
# /usr/local/bin/pi with a shell wrapper that re-exports known provider
# keys from /proc/self/environ (kernel-preserved inside bwrap) before
# exec'ing pi under bun. This sidesteps the empty process.env bug under
# bun inside bwrap (oven-sh/bun#27802) and pi's broken
# restoreSandboxEnv early-return.
#
# The rm -f guarantees /usr/local/bin/pi is not a stale symlink from a
# previous build; without it, the cat > redirect follows the symlink and
# overwrites dist/cli.js with the wrapper content.
RUN rm -f /usr/local/bin/pi \
 && sed -i '1s|^#!/usr/bin/env bun|#!/usr/bin/env node|' \
        /usr/local/install/global/node_modules/@earendil-works/pi-coding-agent/dist/cli.js \
 && cat > /usr/local/bin/pi <<'EOF'
#!/bin/sh
for entry in $(tr '\0' '\n' < /proc/self/environ); do
case "$entry" in
MINIMAX_API_KEY=*|ANTHROPIC_API_KEY=*|ANTHROPIC_AUTH_TOKEN=*|ANTHROPIC_BASE_URL=*|WARREN_API_TOKEN=*|BURROW_API_TOKEN=*|WARREN_BURROW_TOKEN=*|WARREN_QUALITY_GATE=*|OPENAI_API_KEY=*|GEMINI_API_KEY=*|ZAI_API_KEY=*|MISTRAL_API_KEY=*|DEEPSEEK_API_KEY=*|GROQ_API_KEY=*|XAI_API_KEY=*)
export "$entry"
;;
esac
done
exec bun /usr/local/install/global/node_modules/@earendil-works/pi-coding-agent/dist/cli.js "$@"
EOF
RUN chmod +x /usr/local/bin/pi

WORKDIR /app

# Server-side dependencies. Copy lockfiles first so a code-only edit
# doesn't bust the bun install layer.
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile

# Source. Excludes are listed in .dockerignore (node_modules, data, .env,
# src/ui/node_modules, src/ui/dist) so we don't ship dev artefacts.
COPY . /app

# Pull the prebuilt UI bundle from stage 1.
COPY --from=ui-builder /ui-build/dist /app/src/ui/dist

# Put warren itself on PATH. package.json declares bin: { warren, wr } but
# `bun install -g` is not run for /app, so the bin entries aren't wired up.
# Symlink the entrypoint directly — main.ts is +x with a `#!/usr/bin/env bun`
# shebang, so it runs as-is once on PATH.
RUN ln -s /app/src/cli/main.ts /usr/local/bin/warren \
 && ln -s /app/src/cli/main.ts /usr/local/bin/wr

# Default data root — the deploy mounts a persistent volume here.
ENV WARREN_DATA_DIR=/data
ENV WARREN_BURROW_SOCKET=/var/run/burrow.sock

# Pin burrow's data dir onto the same persistent volume warren uses.
ENV BURROW_DATA_DIR=/data/burrow

# /data is a persistence boundary (sqlite + cloned canopy + cloned project
# repos + burrow's db.sqlite under /data/burrow). /var/run is where the
# supervisor binds burrow's unix socket; the directory must exist for
# `burrow serve --socket /var/run/burrow.sock`.
RUN mkdir -p /data /var/run

EXPOSE 8080

ENTRYPOINT ["bun", "run", "src/supervisor/main.ts"]