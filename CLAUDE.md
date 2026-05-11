# Warren

Control plane and UI for cloud-based custom agents. Composes the four
os-eco data-plane tools (canopy, mulch, seeds, sapling) on top of the
[burrow](https://github.com/jayminwest/burrow) sandbox runtime into a
single deployable system: one container, one volume, one HTTP API,
one UI.

[SPEC.md](SPEC.md) is the V1 design record. The manual-run path
(`warren run <agent> <project> -p "..."`) and the cron half of the
scheduler (`.warren/triggers.yaml` + past-due `scheduledFor` seed
extensions, SPEC §11.I) are what V1 ships; GitHub webhook triggers
and library API exports are deferred to V2.

## Relationship to burrow

Warren and burrow are tightly coupled — burrow is the sandbox runtime,
warren is the orchestrator that spawns and talks to it. **Read
`../burrow/SPEC.md` before changing anything that crosses the warren↔burrow
boundary** (the supervisor's `burrow serve` invocation, the `burrow-client/`
HTTP facade, the bwrap-friendly security flags in `docker-compose.yml`).

- The **supervisor** (`src/supervisor/main.ts`) spawns `burrow serve` as a
  sibling process and forwards SIGTERM/SIGINT. They share a unix socket
  (default `/var/run/burrow.sock`) and a bearer token (`BURROW_API_TOKEN` ==
  `WARREN_BURROW_TOKEN`).
- `src/burrow-client/` is a typed facade over `@os-eco/burrow`'s
  `HttpClient`. Don't talk to the socket directly — use the facade so the
  HTTP surface stays mirrored.
- `@os-eco/burrow-cli` is pinned in **two places**: the `Dockerfile` global
  install AND `package.json` + `bun.lock`. Bumping only one is a no-op —
  `Bun.spawn` resolves `./node_modules/.bin/burrow` before PATH, so the
  supervisor runs the local copy. Update both, regenerate the lockfile,
  re-test.
- Burrow needs three apparmor/seccomp/systempaths-unconfined flags + `cap_add:
  SYS_ADMIN` on Linux to do user-namespace nesting (see SPEC §5.3 and burrow
  `DEPLOY.md`). These are baked into `docker-compose.yml`; don't strip them.

## Tech Stack

- **Runtime:** Bun (runs TypeScript directly, no build step on the server)
- **Language:** TypeScript with strict mode (`noUncheckedIndexedAccess`, no `any`)
- **Linting:** Biome (formatter + linter; `--error-on-warnings`, so warnings fail CI)
- **Storage:** SQLite via `bun:sqlite` for runs / events / agents / projects
- **HTTP:** `Bun.serve` — same process serves the JSON API and the SPA
- **UI:** React + Vite + Tailwind + shadcn-style components, lives in
  `src/ui/` as a separate `@os-eco/warren-ui` package; built into
  `src/ui/dist/` and served from there
- **Sandbox primitive:** none directly — burrow owns isolation; warren talks
  to it over HTTP over a unix socket

## Build & Test Commands

From the repo root (server + supervisor + CLI):

```bash
bun test                      # Run all tests
bun test src/foo.test.ts      # Run a single test file
bun run lint                  # biome check --error-on-warnings .
bun run typecheck             # tsc --noEmit
bun run build:ui              # cd src/ui && bun install && bun run build
```

The UI is its own package with its own scripts:

```bash
bun run ui:dev                # vite dev server
bun run ui:install            # cd src/ui && bun install
```

## Quality Gates

Run all three before committing — warnings count as failures:

```bash
bun test && bun run lint && bun run typecheck
```

CI runs the same trinity (see `.github/workflows/release.yml`). Don't merge
with lint warnings; fix at write time or promote to error in `biome.json`.

## TypeScript Conventions

- Strict mode with `noUncheckedIndexedAccess` — always handle possible `undefined` from indexing
- No `any` — use `unknown` and narrow, or define proper types
- Server types co-locate with their domain (`src/server/types.ts`,
  `src/runs/...`, `src/projects/...`); UI types live under `src/ui/src/api/types.ts`
- Import with `.ts` extensions
- Tab indentation, 100-char line width (enforced by Biome)

## Version Management

Version lives in two places — kept in sync manually and verified by the
release workflow:

- `package.json` — `"version"` field
- `src/index.ts` — `export const VERSION = "X.Y.Z"`

There is **no** `bun run version:bump` script in this repo (unlike burrow);
edit both files directly. `.github/workflows/release.yml` fails the release
job if they disagree, then auto-tags `v$VERSION` and creates a GitHub release
from the matching `CHANGELOG.md` section.

## Acceptance Harness

`scripts/acceptance/` runs scenario-based end-to-end checks against a real
warren+burrow stack. Each scenario lives in `scripts/acceptance/scenarios/`
and uses the helpers in `scripts/acceptance/lib/`. New scenarios should be
deterministic, idempotent, and clean up after themselves — they are
expected to run against a live (possibly long-lived) deployment.

## Session Completion Protocol

When ending a work session, complete ALL steps:

1. File issues for remaining work: `sd create --title "..."`
2. Run quality gates (if code changed): `bun test && bun run lint && bun run typecheck`
3. Close finished issues: `sd close <id>`
4. Record insights worth preserving: `ml learn` then `ml record ...`
5. Push: `sd sync && ml sync && git push`
6. Verify: `git status` shows "up to date with origin"

<!-- seeds:start -->
## Issue Tracking (Seeds)
<!-- seeds-onboard:v0.4.0 -->
<!-- seeds-onboard-schema:4 -->

This project uses [Seeds](https://github.com/jayminwest/seeds) v0.4.0 for git-native issue tracking.

**At the start of every session**, run:
```
sd prime
```

This injects session context: rules, command reference, and workflows. Pass `--format json|compact|markdown|plain|ids` on any command for agent-friendly output.

**Quick reference:**
- `sd ready` — Find unblocked work
- `sd search <query>` — Full-text search across titles + descriptions
- `sd create --title "..." --type task --priority 2` — Create issue
- `sd update <id> --status in_progress` — Claim work
- `sd close <id>` — Complete work
- `sd dep add <id> <depends-on>` — Add dependency between issues
- `sd sync` — Sync with git (run before pushing)

### Planning
Use `sd plan` when work is large or ambiguous enough that an LLM benefits from structured decomposition. Submit spawns one child seed per step; `step.blocks` uses forward semantics (step i with `blocks: [j]` means step i blocks step j, and step j gets step i's id in its `blockedBy`).

- `sd plan templates` — List built-ins (`feature`, `bug`, `refactor`) plus custom templates
- `sd plan prompt <seed-id>` — Emit a structured prompt the LLM fills in
- `sd plan submit <seed-id> --plan <file>` — Validate + spawn child seeds
- `sd plan show <pl-id>` — View sections, children, sub-plans
- `sd plan outcome <pl-id> --result success|partial|failure` — Record outcome (storage-only)
- `sd plan review <pl-id> --by <name>` — Record reviewer (informational)

### Before You Finish
1. Close completed issues: `sd close <id>`
2. File issues for remaining work: `sd create --title "..."`
3. Sync and push: `sd sync && git push`
<!-- seeds:end -->

<!-- mulch:start -->
## Project Expertise (Mulch)
<!-- mulch-onboard:v0.8.0 -->

This project uses [Mulch](https://github.com/jayminwest/mulch) v0.8.0 for structured expertise management.

**At the start of every session**, run:
```bash
ml prime
```

Injects project-specific conventions, patterns, decisions, failures, references, and guides into
your context. Run `ml prime --files src/foo.ts` before editing a file to load only records
relevant to that path (per-file framing, classification age, and confirmation scores included).

For monolith projects where dumping every record wastes context, set
`prime.default_mode: manifest` in `.mulch/mulch.config.yaml` (or pass `--manifest`) to emit a
quick reference + domain index. Agents then scope-load with `ml prime <domain>` or
`ml prime --files <path>`.

**Before completing your task**, record insights worth preserving — conventions discovered,
patterns applied, failures encountered, or decisions made:
```bash
ml record <domain> --type <convention|pattern|failure|decision|reference|guide> --description "..."
```

Evidence auto-populates from git (current commit + changed files). Link explicitly with
`--evidence-seeds <id>` / `--evidence-gh <id>` / `--evidence-linear <id>` / `--evidence-bead <id>`,
`--evidence-commit <sha>`, or `--relates-to <mx-id>`. Upserts of named records merge outcomes
instead of replacing them; validation failures print a copy-paste retry hint with missing fields
pre-filled.

Run `ml status` for domain health, `ml doctor` to check record integrity (add `--fix` to strip
broken file anchors), `ml --help` for the full command list. Write commands use file locking and
atomic writes, so multiple agents can record concurrently. Expertise survives `git worktree`
cleanup — `.mulch/` resolves to the main repo.

`ml prune` soft-archives stale records to `.mulch/archive/` instead of deleting them; pass
`--hard` for true deletion. Restore an archived record with `ml restore <id>`. Do not read
`.mulch/archive/` directly — those records are stale by definition. If you need historical
context, run `ml search --archived <query>`.

### Before You Finish

1. Discover what to record (shows changed files and suggests domains):
   ```bash
   ml learn
   ```
2. Store insights from this work session:
   ```bash
   ml record <domain> --type <convention|pattern|failure|decision|reference|guide> --description "..."
   ```
3. Validate and commit:
   ```bash
   ml sync
   ```
<!-- mulch:end -->
