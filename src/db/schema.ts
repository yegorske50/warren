/**
 * SQLite schema for warren's durable state (SPEC §9).
 *
 * Four tables: agents (canopy registry cache), projects (cloned repos), runs
 * (warren-side run rows that mirror burrow's lifecycle), events (write-through
 * cache of burrow's stream — see SPEC §9 "event durability rationale"). The
 * V2 schedules + webhook_secrets tables are intentionally not declared.
 *
 * Timestamps are ISO8601 TEXT, mirroring the burrow event envelope `ts` field
 * so we don't translate at the stream boundary. JSON columns use drizzle's
 * `mode: "json"` (stored as TEXT under the hood; drizzle (de)serializes).
 */

import { sql } from "drizzle-orm";
import { index, integer, real, sqliteTable, text } from "drizzle-orm/sqlite-core";

export const RUN_STATES = ["queued", "running", "succeeded", "failed", "cancelled"] as const;
export type RunState = (typeof RUN_STATES)[number];

export const RUN_TERMINAL_STATES = [
	"succeeded",
	"failed",
	"cancelled",
] as const satisfies readonly RunState[];
export type RunTerminalState = (typeof RUN_TERMINAL_STATES)[number];

/**
 * Failure-cause discriminator for a `failed` run (warren-3c40, warren-5165).
 * `state:failed` alone can't tell several different failure shapes apart.
 * Reap infers from the warren state on entry plus event content:
 *
 *   - still `queued` on entry ⇒ no events ever flowed from burrow ⇒
 *     `never_started` (config/runtime issue, e.g. under-specified prompt).
 *   - `running` on entry but events table holds no model-turn output
 *     (`text` / `thinking` / `tool_use` on stdout) ⇒ `no_model_response`
 *     (typically a credential/auth failure — the original warren-5165
 *     symptom was claude-code emitting an init system event then exiting
 *     with "Not logged in" before any assistant turn — but also covers
 *     rate-limit and provider-network failures).
 *   - `running` on entry with model output ⇒ `crashed` (agent ran and
 *     hit an unrecoverable error mid-conversation).
 *   - `timed_out` is reserved for a future deadline-based reaper — burrow
 *     doesn't currently report a separate timeout state.
 *
 * Null on succeeded/cancelled rows.
 */
export const RUN_FAILURE_REASONS = [
	"never_started",
	"no_model_response",
	"crashed",
	"timed_out",
] as const;
export type RunFailureReason = (typeof RUN_FAILURE_REASONS)[number];

export const EVENT_STREAMS = ["stdout", "stderr", "system"] as const;
export type EventStream = (typeof EVENT_STREAMS)[number];

/**
 * Worker state machine (warren-b0a3 / pl-9ba1 step 1).
 *
 *   - `healthy`     — probe succeeded; eligible for new burrow placement.
 *   - `draining`    — operator-initiated; existing burrows continue to run,
 *                     but `placeFor` skips this worker for new placement.
 *                     Set by `POST /workers/:name/drain` (step 6).
 *   - `unreachable` — probe failed; sticky-by-burrow requests against this
 *                     worker fail loudly rather than silently migrating
 *                     (plan risk #5). Flipped back to `healthy` when probe
 *                     recovers (step 6).
 *
 * A fourth `failed` state is deferred to a future R-NN (plan step 1 prose).
 */
export const WORKER_STATES = ["healthy", "draining", "unreachable"] as const;
export type WorkerState = (typeof WORKER_STATES)[number];

export const agents = sqliteTable("agents", {
	name: text("name").primaryKey(),
	renderedJson: text("rendered_json", { mode: "json" }).notNull(),
	registeredAt: text("registered_at").notNull(),
	lastRefreshed: text("last_refreshed").notNull(),
});

export const projects = sqliteTable(
	"projects",
	{
		id: text("id").primaryKey(),
		gitUrl: text("git_url").notNull(),
		localPath: text("local_path").notNull(),
		defaultBranch: text("default_branch").notNull(),
		addedAt: text("added_at").notNull(),
		lastFetchedAt: text("last_fetched_at"),
		lastHeadSha: text("last_head_sha"),
	},
	(t) => [index("projects_git_url_idx").on(t.gitUrl)],
);

export const runs = sqliteTable(
	"runs",
	{
		id: text("id").primaryKey(),
		agentName: text("agent_name")
			.notNull()
			.references(() => agents.name),
		// Nullable + ON DELETE SET NULL so deleting a project orphans its
		// runs instead of being blocked by the FK. The UI's delete-project
		// dialog promises 'Run history for this project is kept' (warren-5f19);
		// before this change, an FK constraint failure on delete combined
		// with the disk-first ordering in deleteProject left the project
		// row orphaned from its on-disk clone.
		projectId: text("project_id").references(() => projects.id, { onDelete: "set null" }),
		burrowId: text("burrow_id"),
		burrowRunId: text("burrow_run_id"),
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
	},
	(t) => [
		index("runs_state_idx").on(t.state),
		index("runs_project_started_idx").on(t.projectId, sql`${t.startedAt} DESC`),
		index("runs_agent_started_idx").on(t.agentName, sql`${t.startedAt} DESC`),
	],
);

export const events = sqliteTable(
	"events",
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
		index("events_run_seq_idx").on(t.runId, t.burrowEventSeq),
		index("events_run_ts_idx").on(t.runId, t.ts),
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
	"triggers",
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
	(t) => [index("triggers_project_idx").on(t.projectId)],
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
export const workers = sqliteTable("workers", {
	name: text("name").primaryKey(),
	url: text("url").notNull(),
	state: text("state", { enum: WORKER_STATES }).notNull().default("healthy"),
	addedAt: text("added_at").notNull(),
});

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

/**
 * Build the composite PK from a project + trigger pair. The colon separator
 * matches the plan's `<projectId>:<triggerId>` shape so a row key can be read
 * back into its components without consulting the columns.
 */
export function makeTriggerRowId(projectId: string, triggerId: string): string {
	return `${projectId}:${triggerId}`;
}
