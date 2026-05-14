/**
 * Postgres physical schema for warren's durable state (R-13, pl-f17e step 2).
 *
 * Mirror of `./sqlite.ts` — same table names, same column names, same FK
 * targets + onDelete behavior, same index names + columns, same enum tuples.
 * The schemas drift only at the type level:
 *
 *   - `text mode:"json"` (SQLite, stored as TEXT) → `jsonb` (Postgres, stored
 *     as binary; richer query operators, no string round-trip).
 *   - `real` (SQLite, 8-byte IEEE float) → `doublePrecision` (Postgres, 8-byte;
 *     `real` in pg is 4-byte single precision and would lose accuracy on
 *     `costUsd`).
 *   - `integer().primaryKey({autoIncrement:true})` (SQLite ROWID alias) →
 *     `serial().primaryKey()` (Postgres SERIAL = int + sequence).
 *   - Text-enum columns stay TEXT in both (mx-2ab984: TS-only narrowing, no
 *     SQL CHECK).
 *
 * `./drift.test.ts` enforces parity at the column-list / nullability / FK /
 * index level. This schema is not yet wired into `openDatabase` — the
 * dialect-aware client lands in step 3 (warren-a66e). Until then this file
 * is build-only and exercised by the drift test.
 */

import { sql } from "drizzle-orm";
import { doublePrecision, index, integer, jsonb, pgTable, serial, text } from "drizzle-orm/pg-core";
import {
	EVENT_STREAMS,
	INDEX_NAMES,
	PREVIEW_STATES,
	RUN_FAILURE_REASONS,
	RUN_STATES,
	TABLE_NAMES,
	WORKER_STATES,
} from "./columns.ts";

export const agents = pgTable(TABLE_NAMES.agents, {
	name: text("name").primaryKey(),
	renderedJson: jsonb("rendered_json").notNull(),
	registeredAt: text("registered_at").notNull(),
	lastRefreshed: text("last_refreshed").notNull(),
});

export const projects = pgTable(
	TABLE_NAMES.projects,
	{
		id: text("id").primaryKey(),
		gitUrl: text("git_url").notNull(),
		localPath: text("local_path").notNull(),
		defaultBranch: text("default_branch").notNull(),
		addedAt: text("added_at").notNull(),
		lastFetchedAt: text("last_fetched_at"),
		lastHeadSha: text("last_head_sha"),
	},
	(t) => [index(INDEX_NAMES.projectsGitUrl).on(t.gitUrl)],
);

export const runs = pgTable(
	TABLE_NAMES.runs,
	{
		id: text("id").primaryKey(),
		agentName: text("agent_name")
			.notNull()
			.references(() => agents.name),
		projectId: text("project_id").references(() => projects.id, { onDelete: "set null" }),
		burrowId: text("burrow_id"),
		burrowRunId: text("burrow_run_id"),
		workerId: text("worker_id"),
		renderedAgentJson: jsonb("rendered_agent_json").notNull(),
		state: text("state", { enum: RUN_STATES }).notNull(),
		failureReason: text("failure_reason", { enum: RUN_FAILURE_REASONS }),
		startedAt: text("started_at"),
		endedAt: text("ended_at"),
		prompt: text("prompt").notNull(),
		trigger: text("trigger").notNull(),
		prUrl: text("pr_url"),
		costUsd: doublePrecision("cost_usd"),
		tokensInput: integer("tokens_input"),
		tokensOutput: integer("tokens_output"),
		tokensCacheRead: integer("tokens_cache_read"),
		tokensCacheWrite: integer("tokens_cache_write"),
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

export const events = pgTable(
	TABLE_NAMES.events,
	{
		id: serial("id").primaryKey(),
		runId: text("run_id")
			.notNull()
			.references(() => runs.id),
		burrowEventSeq: integer("burrow_event_seq").notNull(),
		ts: text("ts").notNull(),
		kind: text("kind").notNull(),
		stream: text("stream", { enum: EVENT_STREAMS }),
		payloadJson: jsonb("payload_json").notNull(),
	},
	(t) => [
		index(INDEX_NAMES.eventsRunSeq).on(t.runId, t.burrowEventSeq),
		index(INDEX_NAMES.eventsRunTs).on(t.runId, t.ts),
	],
);

export const triggers = pgTable(
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

export const workers = pgTable(TABLE_NAMES.workers, {
	name: text("name").primaryKey(),
	url: text("url").notNull(),
	state: text("state", { enum: WORKER_STATES }).notNull().default("healthy"),
	addedAt: text("added_at").notNull(),
});

export const burrows = pgTable(
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
