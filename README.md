# Warren

Control plane and UI for cloud-based coding agents.

[![CI](https://github.com/jayminwest/warren/actions/workflows/ci.yml/badge.svg)](https://github.com/jayminwest/warren/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)

> A network of interconnected burrows. Agents that operate in isolation, self-manage, self-repair, and self-improve.

Warren composes the [os-eco](https://github.com/jayminwest/os-eco) data-plane tools — [canopy](https://github.com/jayminwest/canopy) (prompts), [mulch](https://github.com/jayminwest/mulch) (expertise), [seeds](https://github.com/jayminwest/seeds) (issues), [sapling](https://github.com/jayminwest/sapling) (harness) — on top of the [burrow](https://github.com/jayminwest/burrow) sandbox runtime into a single deployable system. **One container, one volume, one HTTP API, one UI.**

Run a Claude Code or Sapling agent against any GitHub project from a browser, watch its events stream live, steer it mid-run, and reap its expertise back into the project's `.mulch/` and its open work back into `.seeds/` — all without exposing the agent to the host.

## Status

V1 (`0.1.5`). The manual-run path is end-to-end validated against a deployed Fly.io instance ([SPEC §11.E](SPEC.md#11e-first-run-validation-2026-05-09)) and exercised by 14 scenario-based acceptance tests in [`scripts/acceptance/`](scripts/acceptance/). Scheduler (cron + GitHub webhooks) and library API exports are deferred to V2.

## What you get

- **One image, one volume.** The supervisor (`src/supervisor/main.ts`) is the container ENTRYPOINT — it spawns `burrow serve` first, waits for the unix socket, then spawns warren. SIGTERM/SIGINT forward to both children; burrow restarts under a 5-in-60s budget on unexpected exit.
- **Native sandboxing per run.** Every run gets a fresh `bwrap`-isolated burrow under `/data/burrow/` with the agent's declared `burrow_config`. The host is unreachable; warren talks to burrow over a unix socket with a shared bearer token.
- **Built-in agents, optional library.** `claude-code` and `sapling` ship inline (`src/registry/builtins/`). Set `CANOPY_REPO_URL` to layer a custom canopy library on top — library agents override built-ins by name.
- **Live event stream.** NDJSON events from burrow are persisted to warren's SQLite log and tailed over `GET /runs/:id/events?follow=1`. The UI, CLI (`warren run`), and HTTP clients all consume the same stream.
- **Round-tripped expertise + issues.** Per-run mulch deltas merge into the project's persistent `.mulch/` (last-write-wins by `ts`); seeds the agent marked done are closed; the workspace branch is pushed.
- **Steerable mid-run.** `POST /runs/:id/steer` proxies to burrow's inbox; the next agent turn picks it up. `POST /runs/:id/cancel` aborts cleanly.
- **Three thin clients of one pipeline.** Web UI, `warren` admin CLI, and HTTP API all flow through the same composition path ([SPEC §4.3](SPEC.md#43-the-composition-flow)).

## Architecture

```
┌──────────────── container (bwrap-friendly host) ────────────────┐
│  supervisor  ─┬─►  burrow serve   (unix socket: /var/run/...)   │
│  (Bun parent) └─►  warren         (Bun.serve :8080, SPA + API)  │
│                                                                 │
│  /data/                                                         │
│  ├── canopy-repo/         ← cloned agent library                │
│  ├── projects/<o>/<n>/    ← cloned project repos                │
│  ├── burrow/              ← burrow's home (SQLite, workspaces)  │
│  └── warren.db            ← warren's SQLite (runs, events)      │
└─────────────────────────────────────────────────────────────────┘
                              ▲
                              │  HTTPS (terminated upstream)
                          [browser]
```

Warren and burrow are tightly coupled by design — they are co-tenanted inside the container, share a unix socket, and share a bearer token (`BURROW_API_TOKEN` == `WARREN_BURROW_TOKEN`). See [SPEC §10.3](SPEC.md#103-container-layout) for the full layout.

## Quickstart (home server)

```bash
git clone https://github.com/jayminwest/warren && cd warren
cp .env.example .env && $EDITOR .env
docker compose up -d
open http://localhost:8080
```

Required environment variables (see [`.env.example`](.env.example) for the full list):

| Variable | Purpose |
|---|---|
| `WARREN_API_TOKEN` | Bearer token on every route except `/healthz`. `openssl rand -hex 32`. |
| `BURROW_API_TOKEN` | Token `burrow serve` requires to bind. `openssl rand -hex 32`. |
| `WARREN_BURROW_TOKEN` | Token warren's burrow client sends. **Must equal `BURROW_API_TOKEN`** — they are the two ends of one channel. |
| `ANTHROPIC_API_KEY` | Forwarded to agent runtimes that need it. |
| `GITHUB_TOKEN` | Forwarded for project clones + branch pushes. |

Optional:

| Variable | Purpose |
|---|---|
| `CANOPY_REPO_URL` | Git URL of a canopy agent library. Built-in agents (`claude-code`, `sapling`) cover the common case; set this only if you maintain a custom library and want it loaded on top. Library agents override built-ins by name. |

The compose file applies the four bwrap-required security flags (`apparmor=unconfined`, `seccomp=unconfined`, `systempaths=unconfined`, `cap_add: SYS_ADMIN`) — these relax the outer container so burrow's nested userns sandboxes can come up. Removing any one of them breaks `burrow up`.

## Deploy to Fly.io

Same image, same volume layout, same security flags:

```bash
fly launch                                    # uses ./fly.toml
fly volumes create warren_data --size 50 --region sjc
fly secrets set \
    WARREN_API_TOKEN=... \
    BURROW_API_TOKEN=... \
    WARREN_BURROW_TOKEN=... \
    ANTHROPIC_API_KEY=... \
    GITHUB_TOKEN=...
fly deploy
```

To layer a custom canopy library on top of the built-ins, also set
`CANOPY_REPO_URL=https://github.com/<you>/agents.git`.

## CLI

The `warren` (or `wr`) admin CLI is for ops; the web UI is daily.

| Command | Description |
|---|---|
| `warren register-agent <name>` | Refresh canopy + register one agent |
| `warren add-project <git-url>` | Clone a project under `/data/projects` |
| `warren run <agent> <project> -p "..."` | One-shot run, no UI |
| `warren doctor` | Burrow reachable? Canopy clean? Bwrap working? |
| `warren serve` | Start the HTTP server (default in entrypoint) |

A `warren run claude-code <project> -p "..."` does the full composition end-to-end: resolves the agent (built-in or canopy), provisions the burrow, seeds its `.canopy/` / `.mulch/` / `.seeds/`, dispatches the run, streams events back, then reaps mulch deltas, closes seeds, and pushes the branch.

## HTTP API

```
GET    /agents                       list registered agents (from canopy)
POST   /agents/refresh               re-clone canopy, re-discover
GET    /agents/:name                 rendered agent JSON

GET    /projects                     list cloned projects
POST   /projects                     { gitUrl, defaultBranch? } → clone
POST   /projects/:id/refresh         git fetch + reset to upstream HEAD
DELETE /projects/:id                 remove project

POST   /runs                         { agent, project, prompt } → spawn
GET    /runs                         list (filter by status / agent / project)
GET    /runs/:id                     detail incl. rendered_agent_json
GET    /runs/:id/events?follow=1     NDJSON tail (warren log + live)
POST   /runs/:id/steer               proxy to burrow inbox
POST   /runs/:id/cancel              proxy to burrow cancel

GET    /healthz                      liveness (no auth)
GET    /readyz                       canopy + burrow + first-render check
```

`Authorization: Bearer ${WARREN_API_TOKEN}` is required on every non-`/healthz` route. Warren does not terminate TLS — front it with Caddy on a home server, or rely on Fly's edge.

## Development

Requires [Bun](https://bun.sh) v1.1+.

```bash
bun install
bun test                                          # all unit tests
bun run lint                                      # biome check --error-on-warnings
bun run typecheck                                 # tsc --noEmit
bun test && bun run lint && bun run typecheck     # all quality gates
```

UI development (separate from the server build):

```bash
bun run ui:install
bun run ui:dev
```

The acceptance harness in [`scripts/acceptance/`](scripts/acceptance/) drives 14 scenario-based end-to-end runs against a live container — covering boot health, agent refresh, project lifecycle, run spawn/stream/cancel/steer, restart recovery, mulch + seeds round-tripping, doctor exit codes, supervisor restart-budget, container-mode parity, and `.warren/` config lifecycle. See [ACCEPTANCE.md](ACCEPTANCE.md) for the runbook.

See [CONTRIBUTING.md](CONTRIBUTING.md) for branch naming, testing conventions, and PR expectations.

## Project layout

```
src/
├── index.ts            library entry (V1: VERSION constant only)
├── core/               types, errors, id minting (ag_*, prj_*, run_*)
├── registry/           canopy → agent definition resolution
├── projects/           GitHub clone management
├── runs/               spawn / stream / reap composition flow (SPEC §4.3)
├── burrow-client/      facade over @os-eco/burrow HttpClient
├── supervisor/         container entrypoint (spawns warren + burrow serve)
├── server/             Bun.serve HTTP API + static UI serving
├── db/                 drizzle schema + bun:sqlite repos
├── cli/                warren admin commands
└── ui/                 React + Vite + shadcn SPA
```

## V1 limitations

Documented in [SPEC §11.D](SPEC.md#11d-v1-security-posture-known-limitations) and accepted for this release:

- **Single bearer token.** No rotation, no expiry, no scopes. Loss of `WARREN_API_TOKEN` is full access; rotate by editing `.env` (or `fly secrets set`) and bouncing the container.
- **TLS is upstream's job.** Direct HTTP on a non-loopback bind is a misconfiguration; `warren doctor` warns.
- **Trust-the-socket** between warren and burrow inside the container — they are co-tenanted by design.
- **No CSRF, single-user.** UI calls warren's API with the bearer; CORS is strict.

V2 candidates: scheduler (cron + GitHub webhooks), token-pair (read/write), per-token scopes, audit log, library API exports. See [ROADMAP.md](ROADMAP.md).

## Security

Found a vulnerability? Please follow the disclosure process in [SECURITY.md](SECURITY.md).

## Part of os-eco

Warren is part of the [os-eco](https://github.com/jayminwest/os-eco) AI agent tooling ecosystem.

<p align="center">
  <img src="https://raw.githubusercontent.com/jayminwest/os-eco/main/branding/logo.png" alt="os-eco" width="444" />
</p>

## License

MIT — see [LICENSE](LICENSE).
