# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [0.1.5] — 2026-05-10

R-02 lands: `.warren/` per-project config directory ships end-to-end —
loader, cache, HTTP read endpoint, UI panel, and `warren doctor` /
`/readyz` diagnostics. Triggers are parsed but not dispatched; R-06
(cron scheduler) is the consumer and is now fully unblocked. New
acceptance scenario 14 covers absent / valid / malformed lifecycle.

### Added

- **`feat(warren-config)`** — `.warren/` per-project config directory
  ships end-to-end (R-02, plan `pl-5d74`, warren-571f). Two optional
  files per project: `triggers.yaml` (zod-validated cron entries with a
  `kind:` discriminator that leaves room for future webhook triggers
  without a breaking schema rev) and `defaults.json` (per-project
  `defaultRole` / `defaultBranch` / `defaultPrompt`). Format choice
  diverges from the original ROADMAP sketch: `defaults` is JSON, not
  YAML, for symmetry with the rest of os-eco's wire surface (`mx-2cefdd`).
  YAML parser is `js-yaml ^4.1.1` to match mulch + overstory
  (`mx-8b6896`). New `src/warren-config/` module mirrors the
  `src/projects/` + `src/registry/` layout (errors / config / schema /
  load / cache / index). Loader uses a missing-vs-malformed envelope so
  per-file errors never throw (`mx-66d478`). Per-project cache is
  invalidated inside `refreshProject` and `deleteProject` to dodge the
  stale-config race (pl-5d74 risk #4, `mx-61c0e6`). Triggers are parsed
  but not dispatched — R-06 (cron scheduler) is the consumer and is now
  fully unblocked.
- **`feat(server)`** — `GET /projects/:id/warren-config` returns the
  `LoadedWarrenConfig` envelope verbatim (`{ triggers, defaults, errors }`);
  404 on unknown project. `WarrenConfigUnavailableError` joins the
  existing `BurrowUnreachableError` / `CanopyUnavailableError` /
  `ProjectUnavailableError` family for uniform error handling
  (`mx-adf588`, `mx-bd1f9f`).
- **`feat(ui)`** — Project detail page (`src/ui/src/pages/ProjectDetail.tsx`,
  `mx-dc191e`) renders a read-only Warren Config panel with three blocks
  per envelope: triggers list, defaults key/value, per-file validation
  errors (`mx-a5e30e`). Editing remains a git operation; warren only
  surfaces the parsed view.
- **`feat(diagnostics)`** — `warren doctor` and `/readyz` add a
  `warren_config` check that walks every loaded project and aggregates
  per-file errors into a single diagnostic row (`mx-f37c30`). Doctor's
  check ordering is now eight entries (`mx-1a70ef`); the eighth slot is
  `warren_config`.
- **`test(acceptance)`** — scenario 14
  (`scripts/acceptance/scenarios/14-warren-config-lifecycle.ts`) covers
  `.warren/` lifecycle: absent / valid / malformed states asserted via
  `/readyz` rather than spawning `warren doctor` as a child (avoids the
  wrong-DB problem documented in `mx-e959c0`). Scenarios 11 and 14 also
  pin `WARREN_DB_PATH` to a scratch path so the doctor exit-code check
  doesn't observe the shared dev DB (`mx-544f8f`, `mx-895738`).

### Docs

- **`docs(roadmap)`** — `ROADMAP.md` flips R-02 from `[proposed]` to
  `[shipped]` and inlines the as-built schema, surface, and the scope
  deliberately deferred to R-04 / R-06. R-06's "Depends on" updates to
  show R-02 as satisfied. Suggested-sequencing R-02 entry marked
  shipped. New entry under "Recently shipped".
- **`docs(spec)`** — `SPEC.md` adds §11.H pinning the `.warren/`
  convention into V1's frozen record (layout, format choice, schema,
  loader contract, HTTP/UI/diagnostics surface, deferred scope). §7
  project structure adds `src/warren-config/`; §8.1 HTTP routes adds
  `GET /projects/:id/warren-config`.

## [0.1.4] — 2026-05-10

Acceptance harness fill-in plus a deploy-time guardrail. Six new
end-to-end scenarios (05–10) close the warren↔burrow contract gaps
left by 0.1.3 — events stream, restart-recovery, steer, cancel, and
both reap roundtrips (mulch LWW + seeds-close mirror) — and the
supervisor now fails fast on the misconfigured-token mode that
silently 401'd every dispatch on Fly. Roadmap V2 direction (R-01
through R-11) lands as a planning artifact.

### Added

- **`feat(supervisor)`** — fail fast on missing or mismatched burrow
  auth tokens at boot, before `installGitCredentials` and
  `runSupervisor`. A misconfigured Fly deploy now exits with one
  pointed error instead of crash-looping `burrow serve` five times
  and 401-ing every dispatch. `WARREN_BURROW_NO_AUTH=1` bypasses for
  loopback dev. On success, the validated token's `sha256:<12-hex>`
  fingerprint is logged so a deployer can eyeball that both ends match
  without ever logging the secret. SPEC §10.2 fly secrets block now
  lists `BURROW_API_TOKEN` + `WARREN_BURROW_TOKEN` alongside
  `WARREN_API_TOKEN` (warren-d317).
- **`test(acceptance)`** — scenarios 05+06 cover the events stream
  contract end-to-end. 05 verifies the NDJSON envelope shape on
  `GET /runs/:id/events`, durability via the non-follow replay path,
  and the `?since=` filter. 06 kills warren mid-run, restarts it, and
  asserts the bridge resumes from `MAX(seq)+1` with no event-table
  gaps — the §9 contract. Adds `ScenarioCtx.lifecycle` so process
  control doesn't have to thread through fixtures, plus a per-second
  heartbeat in `stub-agent.sh` so the recovery path has a steady
  source of new burrow events to courier during the warren-down
  window. New `lib/burrow-serve.ts` shim programmatically registers
  declarative `[[agents]]` (which burrow's runtime registry doesn't
  auto-load from a project's `burrow.toml`) and bypasses bwrap with a
  direct `Bun.spawn` so the harness runs cleanly inside warren's own
  production sandbox where userns nesting fails (warren-647e).
- **`test(acceptance)`** — scenarios 07+08 cover steer + cancel. Steer
  asserts the `steer.sent` audit event and the burrow message echo
  prove delivery to the inbox; cancel asserts both warren and burrow
  surfaces report `cancelled`, idempotent on re-cancel (warren-a7f9).
- **`test(acceptance)`** — scenarios 09+10 cover the reap roundtrip.
  Scenario 09 exercises all three SPEC §11.A LWW branches across three
  sequential runs sharing a stable `mulch_id`: added → updated (newer
  ts) → skipped (older ts). Scenario 10 covers the seeds-close mirror
  happy path (`mode='added'`); the `mode='updated'` branch can't be
  observed end-to-end because `spawnRun`'s pre-spawn
  `refreshProjectClone` wipes reap's uncommitted writes to the tracked
  `.seeds/issues.jsonl` between runs (mulch's `acceptance.jsonl`
  survives because it's not committed in the fixture);
  `mirrorClosedSeeds`' updated branch is exercised by `reap.test.ts`.
  The stub agent gains four prompt-driven knobs alongside
  `[sleep_ms=NNN]`: `[mulch_id=...]`, `[mulch_ts=...]`, `[seed_id=...]`,
  `[seed_ts=...]` — letting scenarios drive deterministic LWW inputs
  without warren restarts (warren-c37e).

### Fixed

- **`test(acceptance)`** — scenario 02 now filters built-ins out of
  the "agents list is empty before first refresh" precondition. The
  server now boot-seeds claude-code + sapling built-ins (mx-f52e13),
  so the original assertion was always wrong. Filters to
  `source !== 'builtin'` before counting; `AgentRow` gains the
  optional `source` field already returned by `GET /agents`
  (warren-3682).

### Changed

- **TypeScript `5.9.3 → 6.0.3`** — dev dependency bump (dependabot).

### Docs

- **`docs(roadmap)`** — `ROADMAP.md` adds the V2 direction (R-01
  through R-11): the team-of-ICs phase. Captures seeds extensions,
  `.warren/` config dir, per-project canopy tier, project + issues UI
  (multica pattern), roles tab editor, cron scheduler, sapling-first
  runtime, operator agent, schema-driven config UI, and canopy+mulch
  role meshing. Records the decisions already made (DB only for
  runtime state; seeds is source of truth for issues; markdown editor
  with full canopy feature set; sapling personal default, claude-code
  public default). Cross-repo follow-ups tracked as seeds in
  seeds/sapling/canopy/mulch.
- **`docs(fly)`** — `fly.toml` operator-workflow comment now spells
  out the `BURROW_API_TOKEN` ↔ `WARREN_BURROW_TOKEN` pairing
  requirement. Deploying without setting both to the same value
  crashed the supervisor in a boot loop, then silently 401'd every
  dispatch once the server-side secret was set alone. App name
  corrected to `warren-deployed` to match the created Fly app
  (warren-d317).

## [0.1.3] — 2026-05-09

Third-dogfood follow-through. Closes the warren-on-warren findings from
SPEC §11.G: agents now actually `git commit` (system prompt reaches the
runtime, gitdir bind via burrow 0.2.7), reap distinguishes empty pushes
from real work, successful pushes auto-open a GitHub PR, the dispatch
form lets operators target a non-default branch, and `CANOPY_REPO_URL`
is now optional thanks to inline built-in agents.

### Added

- **`feat(runs)`** — auto-open a GitHub PR after reap pushes the agent's
  branch. Gated by `WARREN_AUTO_OPEN_PR` (default on); skipped when the
  run isn't successful, the push lands no commits, the branch matches
  `project.defaultBranch`, or `GITHUB_TOKEN` is unset. 422 "already
  exists" is treated as success and the existing PR url is recovered.
  Optional `WARREN_BASE_URL` embeds a back-link to the run in the PR
  body (warren-f6af).
- **`feat(runs)`** — reap distinguishes a real-work push from a no-op
  push against an unchanged HEAD. After a successful push reap runs
  `git rev-list --count <project.defaultBranch>..HEAD` and pins the
  count on `ReapRunResult.commitsAhead`. When the count is 0, an extra
  `reap.empty_push` system event fires and `reap.completed` carries
  `commitsAhead: 0`. RunDetail's header shows a destructive
  "empty push" badge or a green "+N commits" badge accordingly. SPEC
  §4.3 step 6 documents the commit/push contract (warren-f3bb).
- **`feat(runs)`** — dispatch composes `agent.system + delimiter + user
  prompt` before posting to `POST /burrows/:id/runs`. Burrow's
  claude-code runtime never reads `.canopy/agent.json`, so the canopy
  `system` body (workspace map, rituals, commit-only invariant per
  warren-1a09) was dead text on disk; it now actually reaches the model.
  `runs.prompt` keeps the user-typed input verbatim — only the body sent
  to burrow is composed.
- **`feat(ui)`** — NewRun page exposes a free-text "Branch / tag / SHA
  (optional)" field between project select and prompt textarea.
  Placeholder mirrors the project's `defaultBranch`; empty submissions
  are omitted from the `POST /runs` body so the server falls back to
  `defaultBranch` as before (warren-7589).
- **`feat(registry)`** — `CANOPY_REPO_URL` is now optional. Warren ships
  default `claude-code` and `sapling` agents inline (`src/registry/builtins/`)
  so a fresh deploy boots without a custom canopy library. When
  `CANOPY_REPO_URL` *is* set, library agents override built-ins by name
  and new names extend the catalog. `warren doctor` and `/readyz` no
  longer fail when the canopy clone is absent (warren-d3e9).
- **`test(acceptance)`** — scenario 04 drives the §4.3 composition flow
  end-to-end against the in-proc warren+burrow harness. Asserts
  `POST /runs` returns 201 with a `run_xxx` id and a populated
  `renderedAgentJson`, and that the column is frozen at spawn time —
  mutating the canopy fixture and re-running `POST /agents/refresh`
  leaves the existing run unchanged while a fresh spawn picks up the
  drift. `canopyRepoPath` is surfaced on `ScenarioCtx.fixtures` so
  future scenarios can drive canopy-source mutations the same way
  (warren-9f65).

### Changed

- **Burrow CLI bumped `0.2.6 → 0.2.7`** — pulls in the burrow-7a80
  gitdir-bind fix. Host worktree gitdir is now visible inside the bwrap
  sandbox, so agents can run `git commit` on their own workspaces. Two-
  place pin (Dockerfile + `package.json` + `bun.lock`) per CLAUDE.md.
- **TypeScript `5.9.3 → 6.0.3`** — dev dependency bump (dependabot).

### Docs

- **`docs(spec)`** — SPEC §11.G records the 2026-05-09 third dogfood.
  Two warren-on-warren runs against `jayminwest/warren`: the first
  reproduced the silent-empty-branch shape (`branchPushed: true`,
  `ahead_by: 0`) — the trigger for warren-f3bb (reap-pushes-without-
  committing observability gap) and warren-fead (`end_turn` while
  waiting on foreground work). The second was the first warren-on-
  warren run that actually shipped real work to the remote, validating
  burrow-7a80 / 0.2.7 gitdir bind end-to-end and confirming
  warren-f3bb's prompt-instruction-is-sufficient fix scope. Filed
  warren-1a09 (P2: agent-side `git push` blocked by `/root/.gitconfig`
  not being in burrow's bwrap ro-bind set; same architectural pattern
  as warren-1eaa).

## [0.1.2] — 2026-05-09

Second-dogfood hardening pass. Fixes the "stuck running, no branch" failure
mode (warren-a69a + warren-67cc compound) by reaping inline on terminal
bridge events, repairs container recreate past migration 0002 (warren-b060),
makes the bundled os-eco CLIs resolvable inside the bwrap sandbox
(warren-1eaa), and survives `DELETE /projects/:id` against a project with
run history (warren-5f19). Burrow bumped to 0.2.6 for built-in
`ANTHROPIC_API_KEY` plumbing.

### Fixed

- **`fix(runs)`** — reap runs inline when the burrow bridge sees a runtime
  terminal event (`kind=state_change`, `stream=system`,
  `payload.type=result`) or when burrow's cancel response carries a terminal
  state. Without an external scheduler, runs were stuck in `running` after
  the agent exited or the operator cancelled; reap is still the sole writer
  to the terminal state transition (warren-a69a).
- **`fix(runs)`** — adds `no_model_response` to `failure_reason`, so the
  reap classifier discriminates "ran but the model never produced an
  assistant turn" (e.g. claude-code's "Not logged in / Please run /login"
  exit) from a generic crash. Heuristic: outcome=failed, stateOnEntry=running,
  no `text`/`thinking`/`tool_use` event ever landed on `stream=stdout`
  (warren-5165).
- **`fix(db)`** — hoists `PRAGMA foreign_keys=OFF` onto the raw connection
  *before* drizzle's migrate transaction opens. SQLite silently ignores
  PRAGMA foreign_keys toggled inside a multi-statement transaction, so
  migration 0003's "12-step ALTER" was running with FK still ON and
  crashing the supervisor on every container recreate past 0002 against any
  `/data/warren.db` with `events` rows referencing `runs` (warren-b060).
- **`fix(docker)`** — relocates the global Bun package store from `/root/.bun`
  to `/usr/local`. Burrow's bwrap profile ro-binds `/usr` but not `/root`,
  so symlinks in `/usr/local/bin` for `sd`/`ml`/`cn`/`sapling`/`burrow` were
  dangling inside the agent's UID-1000 namespace. Sandboxed agents can now
  resolve every bundled os-eco CLI (warren-1eaa).
- **`fix(projects)`** — `runs.project_id` switched to `ON DELETE SET NULL`
  and `deleteProject` now reorders so a delete of a project with run history
  succeeds instead of state-corrupting on the FK error after `rmrf` already
  wiped the disk. Reap guards a null `projectId` by skipping
  `mulch_merge`/`seeds_close`/`branch_push`; UI renders orphans as
  "(deleted project)" on the runs list and detail (warren-5f19).
- **`fix(ui)`** — `RunDetail` invalidates the `['runs']` query when the live
  event stream emits `state_change`, `cancel.requested`, `reap.completed`,
  or `reap_failed`. The state badge and metadata refresh immediately instead
  of waiting on the 3–5s polling backstop. The cancel button now surfaces
  burrow's post-cancel state inline (alreadyTerminal vs. forwarded + state)
  matching SteerForm's no-toast pattern (warren-d9ad).

### Changed

- **Burrow CLI bumped `0.2.4 → 0.2.6`** — built-in claude-code runtime
  now default-allows `ANTHROPIC_API_KEY` (plus `ANTHROPIC_AUTH_TOKEN`,
  `ANTHROPIC_BASE_URL`, `CLAUDE_CODE_OAUTH_TOKEN`) without requiring a
  project `burrow.toml` `[env]` block. Pinned in **both** `Dockerfile` and
  `package.json` + `bun.lock`.
- **`.env.example`** — replaces the misleading `env_passthrough` claim
  (warren never wired project-level passthrough; deferred to warren-766b)
  with a description of burrow's built-in claude-code env contract
  (warren-5165).

### Docs

- **`docs(claude)`** — `CLAUDE.md` now covers tech stack, build/test
  commands, quality gates, version management, and an explicit "Relationship
  to burrow" section (supervisor contract, two-place `@os-eco/burrow-cli`
  pin, bwrap security flags).
- **`docs(spec)`** — SPEC §11.F records the second-dogfood findings
  (warren-67cc + warren-a69a as the "stuck running, no branch" compound).

### Build

- **`ci(release)`** — configures `git config user.name/email` before
  `git tag -a` in the release workflow. Without an identity the runner
  failed with "empty ident name not allowed" and `v0.1.1` never tagged.

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
