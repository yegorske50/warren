# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [0.1.1] — 2026-05-09

Post-V1 hardening pass. Closes every "Known limitations" seed filed against
0.1.0 — `GITHUB_TOKEN` git auth, `--no-auth` burrow knob, warren-on-PATH,
queued-vs-crashed reap classification, and `curl` in the runtime image — plus
projects can now refresh on every run, run streams survive Bun's 10s idle
timeout, and the UI no longer overflows on wide tables.

### Added

- **`feat(projects)`** — every run now `git fetch`-refreshes the project clone
  before composing the burrow; the new `POST /projects/:id/refresh` endpoint
  exposes the same flow for manual use. Persistent clones in
  `/data/projects/<owner>/<name>` no longer drift from upstream.
- **`feat(supervisor)`** — `BURROW_NO_AUTH` and `BURROW_EXTRA_ARGS` env knobs
  splice into the supervisor's `burrow serve` invocation, supporting loopback
  dev without bearer auth (warren-93ee).
- **`feat(runs)`** — failed runs now carry a `failure_reason` column
  (`crashed | never_started | cancelled | timeout | reap_failed`), so reap can
  distinguish "queued, never started" from "crashed mid-run" (warren-3c40).
- **`feat(docker)`** — `curl` is installed in the runtime image so operators
  can probe the burrow unix socket from inside the container (warren-bd69).
- **`test(acceptance)`** — scenario 03 covers projects management end-to-end
  (clone, presence checks, refresh, reap merge).

### Fixed

- **`fix(ui)`** — `min-w-0` on the main pane prevents wide tables (events,
  reap output) from pushing the viewport horizontally on the runs page
  (warren-930c).
- **`fix(docker)`** — the `warren` CLI is now symlinked onto `PATH` inside
  the container; previously `docker exec ... warren doctor` failed (warren-fab1).
- **`fix(supervisor)`** — `GITHUB_TOKEN` is wired into `git config --global
  url.<token>@github.com.insteadOf` at supervisor boot, so private project
  clones work without per-run setup (warren-dcf3).
- **`fix(runs)`** — runs transition `queued → running` on the first burrow
  bridge event (previously stuck in `queued` until completion) (warren-865e).
- **`fix(server)`** — run-event SSE streams are kept alive past Bun's 10s
  idleTimeout via periodic comments; long-running agents no longer drop the
  client connection mid-run (warren-b8fc).

### Build

- Added `.github/workflows/release.yml` — pushes to `main` that bump
  `package.json#version` (kept in sync with `src/index.ts`'s `VERSION`)
  automatically tag `v$VERSION` and create a GitHub release with notes
  extracted from `CHANGELOG.md`. The workflow is idempotent: re-runs against
  an already-tagged version are a no-op.

## [0.1.0] — 2026-05-09

Inaugural release. The V1 manual-run path is end-to-end validated against a real
claude-code agent (SPEC §11.E): `warren run claude-code <project> -p "..."`
provisions a burrow, dispatches the run, streams events back, reaps mulch
deltas, and pushes the workspace branch.

### Added

- **Composition flow** (SPEC §4.3): canopy agent resolution → burrow provision
  → seed `.canopy`/`.mulch`/`.seeds` → dispatch → NDJSON event stream → reap.
  Rendered agent JSON is frozen on the run row at spawn time so mid-run canopy
  edits do not affect in-flight runs.
- **Phase 0** — Bun + TS strict scaffolding (biome, drizzle, src tree).
- **Phase 1** — data model + `bun:sqlite` repos for `agents`, `projects`,
  `runs`, `events`.
- **Phase 2** — `burrow-client/` facade over `@os-eco/burrow` `HttpClient`
  (typed mirror of burrow's HTTP surface over the supervisor-managed unix
  socket).
- **Phase 3** — canopy agent registry: `cn render` → `AgentDef`, schema
  validation, refresh on demand.
- **Phase 4** — project management: clone GitHub URLs into
  `/data/projects/<owner>/<name>`, presence checks for `.seeds`/`.mulch`.
- **Phase 5** — run spawn / composition flow.
- **Phase 6** — event streaming + warren event log (write-through cache of
  burrow's stream; supports reload-after-crash and post-hoc replay).
- **Phase 7** — reap: per-run `.mulch/` merged into the project's persistent
  expertise log with last-write-wins-by-`ts` (SPEC §11.A); seeds the agent
  closed are propagated; workspace branch is pushed.
- **Phase 8** — `POST /runs/:id/steer` and `POST /runs/:id/cancel`, proxying
  to burrow's inbox + cancel routes.
- **Phase 9** — Bun.serve HTTP API + bearer-token auth on every route except
  `/healthz`. CORS strict; SPA shell + assets are auth-exempt so the UI loads
  before the user has configured the token.
- **Phase 10** — React + Vite + shadcn/ui SPA served by the same Bun.serve
  process from `src/ui/dist/`.
- **Phase 11** — `warren` admin CLI: `register-agent`, `add-project`, `run`,
  `doctor`, `serve` (the docker entrypoint).
- **Phase 12** — container + supervisor: `src/supervisor/main.ts` spawns
  `burrow serve` + warren as siblings, forwards SIGTERM/SIGINT, restarts
  burrow on crash with a 5-in-60s budget. Two-stage Dockerfile (UI build +
  runtime).
- **Phase 13** — `warren doctor` (burrow reachable, canopy clean, bwrap
  working) and `/readyz` (canopy clone present, burrow socket reachable, at
  least one agent rendered).
- **Phase 14** — acceptance harness skeleton (`scripts/acceptance/`) for
  scenario-based end-to-end validation.
- **Deploy** — `docker-compose.yml` with the four bwrap-friendly security
  flags (apparmor/seccomp/systempaths unconfined + `cap_add: SYS_ADMIN`,
  SPEC §5.3) and a single named volume at `/data`. `fly.toml` for Fly.io
  with the same image and security posture.
- **Bundled runtime** — the image installs `@os-eco/burrow-cli`,
  `@os-eco/canopy-cli`, `@os-eco/seeds-cli`, `@os-eco/mulch-cli`,
  `@os-eco/sapling-cli`, and `@anthropic-ai/claude-code` at fixed pins, with
  an explicit postinstall invocation for claude-code so the platform-native
  binary is wired up.

### Fixed

- `fix(spawn)` — forward `agent.name` as an `[[agents]]` patch row to
  `burrow up`, so burrow can resolve toolchain paths via
  `resolveEffectiveAgents` (paired with burrow `0.2.2`).
- `fix(server)` — SPA shell + asset routes are bearer-auth-exempt; previously
  the UI could not bootstrap on a fresh deploy.
- `fix(deploy)` — unblock first-run image build + boot.

### Build

- Pinned `@os-eco/burrow-cli` to `0.2.3` for bwrap `--uid`/`--gid` mapping
  (claude-code refuses to run as host root with
  `--dangerously-skip-permissions`). Bumped in **both** `Dockerfile` and
  `package.json` + `bun.lock` — the supervisor's `Bun.spawn` resolves
  `./node_modules/.bin/burrow` before PATH, so a Dockerfile-only bump is a
  no-op.
- Bundled `claude-code` runtime into the image with explicit postinstall so
  `bun install -g`'s skipped lifecycle scripts don't leave `/usr/local/bin/claude`
  unwired.
- Dropped the npm publish workflow — warren ships as a container image, not
  an npm package.

### Known limitations (V1)

See SPEC §11.D for the security posture (single bearer token, no rotation,
trust-the-socket between warren and burrow). Outstanding gaps tracked as
warren seeds: supervisor doesn't auto-wire `GITHUB_TOKEN` into git's
credential helper (`warren-dcf3`), no `--no-auth` knob for burrow loopback
dev (`warren-93ee`), `warren` CLI not on `PATH` inside the container
(`warren-fab1`), reap can't distinguish "queued, never started" from
"crashed" (`warren-3c40`), runtime image lacks `curl` (`warren-bd69`).
Scheduler (cron + webhooks) and library API exports are deferred to V2.
