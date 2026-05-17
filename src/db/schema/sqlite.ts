/**
 * SQLite physical schema for warren's durable state (SPEC §9).
 *
 * Seven tables: agents (canopy registry cache), projects (cloned repos), runs
 * (warren-side run rows that mirror burrow's lifecycle), events (write-through
 * cache of burrow's stream — see SPEC §9 "event durability rationale"),
 * triggers (R-06 scheduler bookkeeping), workers + burrows (multi-worker
 * placement registry, warren-b0a3 / warren-135b).
 *
 * Timestamps are ISO8601 TEXT, mirroring the burrow event envelope `ts` field
 * so we don't translate at the stream boundary. JSON columns use drizzle's
 * `mode: "json"` (stored as TEXT under the hood; drizzle (de)serializes); the
 * Postgres mirror uses `jsonb`.
 *
 * Constants and table/index names live in `./columns.ts`; the parallel pg
 * physical schema is in `./postgres.ts`. Drift between the two is caught by
 * `./drift.test.ts`.
 */

import { sql } from "drizzle-orm";
import { index, integer, real, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core";
import {
	EVENT_STREAMS,
	INDEX_NAMES,
	PREVIEW_STATES,
	RUN_FAILURE_REASONS,
	RUN_STATES,
	TABLE_NAMES,
	WORKER_STATES,
} from "./columns.ts";

/**
 * Canopy registry cache. Three tiers of rows live here, addressed by
 * (name, project_id):
 *
 *   - built-in   (`source = 'builtin'`)        — `project_id IS NULL`
 *   - library    (`source = 'library'`)        — `project_id IS NULL`
 *   - project    (`source = 'project:<id>'`)   — `project_id = <id>`
 *
 * R-03 (pl-fef5, warren-094a) replaced the single-column `name` primary
 * key with a synthetic rowid PK so the project tier can carry duplicate
 * names across projects. Identity is enforced at the index layer:
 *
 *   - composite unique on (project_id, name) for project-tier rows.
 *   - partial unique on (name) WHERE project_id IS NULL for the global
 *     tier — SQLite treats NULL as distinct in plain unique indexes, so
 *     the composite alone would allow two `(NULL, "claude-code")` rows.
 *
 * `runs.agent_name` used to FK to `agents.name`; with composite identity
 * the FK is unrepresentable in SQLite (no composite FK from a single
 * column), so it was dropped. The agents table is a soft cache —
 * spawn-time lookups fall back to "global" if a project-tier row is
 * missing and `POST /agents/refresh` re-discovers from canopy.
 */
export const agents = sqliteTable(
	TABLE_NAMES.agents,
	{
		id: integer("id").primaryKey({ autoIncrement: true }),
		projectId: text("project_id").references(() => projects.id, { onDelete: "cascade" }),
		name: text("name").notNull(),
		renderedJson: text("rendered_json", { mode: "json" }).notNull(),
		registeredAt: text("registered_at").notNull(),
		lastRefreshed: text("last_refreshed").notNull(),
	},
	(t) => [
		uniqueIndex(INDEX_NAMES.agentsProjectName).on(t.projectId, t.name),
		uniqueIndex(INDEX_NAMES.agentsGlobalName).on(t.name).where(sql`${t.projectId} IS NULL`),
	],
);

export const projects = sqliteTable(
	TABLE_NAMES.projects,
	{
		id: text("id").primaryKey(),
		gitUrl: text("git_url").notNull(),
		localPath: text("local_path").notNull(),
		defaultBranch: text("default_branch").notNull(),
		addedAt: text("added_at").notNull(),
		lastFetchedAt: text("last_fetched_at"),
		lastHeadSha: text("last_head_sha"),
		// Plot opt-in gating flag (warren-4e20). True iff a `.plot/` directory
		// exists at the clone root at the time of the most recent
		// addProject / refreshProjectClone. The dispatch path reads this to
		// gate `plot_id` validation and PLOT_ID/PLOT_ACTOR env injection
		// (warren-a8c3, warren-e26f). Defaults to false so legacy rows
		// written before this column existed match the no-`.plot/` shape.
		hasPlot: integer("has_plot", { mode: "boolean" }).notNull().default(false),
	},
	(t) => [index(INDEX_NAMES.projectsGitUrl).on(t.gitUrl)],
);

export const runs = sqliteTable(
	TABLE_NAMES.runs,
	{
		id: text("id").primaryKey(),
		// Plain text, no FK to agents.name. With R-03 (pl-fef5, warren-094a)
		// agents are identified by (name, project_id) rather than a single-
		// column PK, so this FK is no longer representable. The agents table
		// is a soft cache anyway — spawn resolves `(agentName, projectId)`
		// with global fallback at the application layer.
		agentName: text("agent_name").notNull(),
		// Nullable + ON DELETE SET NULL so deleting a project orphans its
		// runs instead of being blocked by the FK. The UI's delete-project
		// dialog promises 'Run history for this project is kept' (warren-5f19);
		// before this change, an FK constraint failure on delete combined
		// with the disk-first ordering in deleteProject left the project
		// row orphaned from its on-disk clone.
		projectId: text("project_id").references(() => projects.id, { onDelete: "set null" }),
		burrowId: text("burrow_id"),
		burrowRunId: text("burrow_run_id"),
		// Denormalized worker placement (warren-135b / pl-9ba1 step 2).
		// Copy of `burrows.worker_id` written at run-create time so streaming /
		// cancel / steer paths can route to the owning worker without a join.
		// Plain text (no FK to `workers.name`) because the zero-config single-
		// worker deploy uses a synthetic local worker that has no row in the
		// `workers` table. Nullable for back-compat with rows written before
		// this column landed; new rows always set it once `BurrowClientPool`
		// (step 3) and the spawn wiring (step 4) land.
		workerId: text("worker_id"),
		// Optional back-link to the seeds issue this run was dispatched against
		// (pl-bb70 step 3, warren-805a). Threaded through POST /runs → spawnRun →
		// runs row so the post-dispatch `updateExtensions` write (pl-bb70 step 4)
		// has a seed to merge {role, trigger, lastRunId, lastRunAt} into.
		// Nullable: legacy rows and runs dispatched without a seed leave it null.
		// Plain text (no FK to seeds) — seeds live in the project workspace, not
		// in warren's database, and the seed-id space is per-project.
		seedId: text("seed_id"),
		renderedAgentJson: text("rendered_agent_json", { mode: "json" }).notNull(),
		state: text("state", { enum: RUN_STATES }).notNull(),
		failureReason: text("failure_reason", { enum: RUN_FAILURE_REASONS }),
		startedAt: text("started_at"),
		endedAt: text("ended_at"),
		prompt: text("prompt").notNull(),
		trigger: text("trigger").notNull(),
		// PR URL filled in by reap's pr_open sub-step (warren-f6af) when the
		// agent's branch push lands real commits and WARREN_AUTO_OPEN_PR is on.
		// Null encodes "no PR was opened" — auto-open disabled, push failed,
		// branch == defaultBranch, no commits ahead, or the GitHub call itself
		// errored (recorded as a `reap_failed` event with step=pr_open).
		prUrl: text("pr_url"),
		// Per-run cost + token accounting (warren-a7dc). All nullable: only the
		// pi runtime reports session-cumulative stats via get_session_stats today,
		// and even there the value is best-effort (null when the bridge can't
		// snapshot the RPC). Cost is the persisted delta between run-start and
		// run-end snapshots so resumed pi sessions don't double-count prior turns.
		costUsd: real("cost_usd"),
		tokensInput: integer("tokens_input"),
		tokensOutput: integer("tokens_output"),
		tokensCacheRead: integer("tokens_cache_read"),
		tokensCacheWrite: integer("tokens_cache_write"),
		// Per-run preview environment columns (R-19 / SPEC §11.L). All nullable
		// because only projects that opt in via `.warren/defaults.json`'s
		// `preview` block exercise this path; non-opted-in runs leave every
		// field null. Populated by reap's `preview_launch` sub-step, the
		// readiness probe, the host reverse proxy (last_hit_at), and the
		// eviction worker / manual teardown route. ISO8601 TEXT mirrors the
		// existing started_at/ended_at convention so cross-dialect passthrough
		// (mx-845f11) stays lossless.
		previewState: text("preview_state", { enum: PREVIEW_STATES }),
		previewPort: integer("preview_port"),
		previewStartedAt: text("preview_started_at"),
		previewLastHitAt: text("preview_last_hit_at"),
		previewFailureMessage: text("preview_failure_message"),
	},
	(t) => [
		index(INDEX_NAMES.runsState).on(t.state),
		index(INDEX_NAMES.runsProjectStarted).on(t.projectId, sql`${t.startedAt} DESC`),
		index(INDEX_NAMES.runsAgentStarted).on(t.agentName, sql`${t.startedAt} DESC`),
		index(INDEX_NAMES.runsWorkerState).on(t.workerId, t.state),
	],
);

export const events = sqliteTable(
	TABLE_NAMES.events,
	{
		id: integer("id").primaryKey({ autoIncrement: true }),
		runId: text("run_id")
			.notNull()
			.references(() => runs.id),
		burrowEventSeq: integer("burrow_event_seq").notNull(),
		ts: text("ts").notNull(),
		kind: text("kind").notNull(),
		stream: text("stream", { enum: EVENT_STREAMS }),
		payloadJson: text("payload_json", { mode: "json" }).notNull(),
	},
	(t) => [
		index(INDEX_NAMES.eventsRunSeq).on(t.runId, t.burrowEventSeq),
		index(INDEX_NAMES.eventsRunTs).on(t.runId, t.ts),
	],
);

/**
 * R-06 scheduler state (warren-3f59).
 *
 * One row per (project, trigger-id-from-.warren/triggers.yaml). The PK is a
 * composite string `<projectId>:<triggerId>` so the scheduler tick can write
 * back last/next fire timestamps without juggling a separate generated id —
 * the trigger's authoring identity in YAML is what survives across restarts.
 *
 * The trigger definition itself stays in .warren/triggers.yaml (R-02); only
 * mutable scheduler bookkeeping lives here. last_run_id points at the most
 * recent dispatched run (ON DELETE SET NULL so deleting a run row doesn't
 * orphan the trigger). project_id is the cascade root — deleting the project
 * drops its triggers, mirroring the .warren/ clone going away with it.
 */
export const triggers = sqliteTable(
	TABLE_NAMES.triggers,
	{
		id: text("id").primaryKey(),
		projectId: text("project_id")
			.notNull()
			.references(() => projects.id, { onDelete: "cascade" }),
		triggerId: text("trigger_id").notNull(),
		lastFiredAt: text("last_fired_at"),
		nextFireAt: text("next_fire_at"),
		lastRunId: text("last_run_id").references(() => runs.id, { onDelete: "set null" }),
	},
	(t) => [index(INDEX_NAMES.triggersProject).on(t.projectId)],
);

/**
 * Multi-worker placement registry (warren-b0a3 / pl-9ba1 step 1, parent
 * warren-6747).
 *
 * Each row is one burrow worker warren can dispatch to. `name` is the stable
 * operator-chosen handle (used in URLs like `POST /workers/:name/drain` and
 * referenced by `burrows.worker_id` / `runs.worker_id` once those columns
 * land in step 2). `url` is the transport target (`unix:///var/run/burrow.sock`
 * or `http://host:port`); `BurrowClientPool` (step 3) builds an `HttpClient`
 * per row keyed by name.
 *
 * The bearer token is intentionally NOT stored here: the deploy uses a single
 * shared `BURROW_API_TOKEN` env var across the pool (plan alternative #3 —
 * VPC-private threat model; rotation = one env-var update across the fleet).
 *
 * Zero-row table is the steady state for today's single-worker deploys —
 * `BurrowClientPool` synthesizes a local row from `WARREN_BURROW_*` env vars
 * when this table is empty, preserving back-compat (acceptance #1). Operators
 * with a `[workers]` block in warren config materialize rows here at boot
 * (step 7 lands that loader).
 */
export const workers = sqliteTable(TABLE_NAMES.workers, {
	name: text("name").primaryKey(),
	url: text("url").notNull(),
	state: text("state", { enum: WORKER_STATES }).notNull().default("healthy"),
	addedAt: text("added_at").notNull(),
});

/**
 * Per-burrow worker assignment (warren-135b / pl-9ba1 step 2).
 *
 * Source of truth for `{burrow_id → worker_id}`. One row per burrow warren
 * has provisioned; written at burrow-create time (step 4 wires the spawn
 * flow), read by `clientFor({burrowId})` on every sticky-by-burrow request
 * (stream / cancel / steer / events tail) so warren routes to the worker
 * that physically holds the sandbox + burrow-side SQLite row.
 *
 * `runs.worker_id` is a denormalized copy of this column written at
 * run-create time so streaming paths don't have to join.
 *
 * `worker_id` is plain text without a FK to `workers.name` because the
 * zero-config single-worker deploy uses a synthetic local worker that has
 * no row in `workers` (back-compat with today's `WARREN_BURROW_*` env-var
 * deploys; the loader in step 7 materializes rows only when a `[workers]`
 * block is configured).
 *
 * Sticky-by-burrow is the design (plan risk #5): if the row's `worker_id`
 * points at an `unreachable` worker, `placeForBurrow` fails loudly rather
 * than silently migrating. Operators drain + remove a dead worker to clear
 * orphans (`warren doctor` will surface them as `worker_missing`).
 */
export const burrows = sqliteTable(
	TABLE_NAMES.burrows,
	{
		id: text("id").primaryKey(),
		workerId: text("worker_id").notNull(),
		addedAt: text("added_at").notNull(),
	},
	(t) => [index(INDEX_NAMES.burrowsWorker).on(t.workerId)],
);

export type AgentRow = typeof agents.$inferSelect;
export type AgentInsert = typeof agents.$inferInsert;
export type ProjectRow = typeof projects.$inferSelect;
export type ProjectInsert = typeof projects.$inferInsert;
export type RunRow = typeof runs.$inferSelect;
export type RunInsert = typeof runs.$inferInsert;
export type EventRow = typeof events.$inferSelect;
export type EventInsert = typeof events.$inferInsert;
export type TriggerRow = typeof triggers.$inferSelect;
export type TriggerInsert = typeof triggers.$inferInsert;
export type WorkerRow = typeof workers.$inferSelect;
export type WorkerInsert = typeof workers.$inferInsert;
export type BurrowRow = typeof burrows.$inferSelect;
export type BurrowInsert = typeof burrows.$inferInsert;
