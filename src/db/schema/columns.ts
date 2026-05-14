/**
 * Dialect-agnostic schema constants shared between the SQLite and Postgres
 * physical schemas (R-13, pl-f17e step 2).
 *
 * Drizzle has no shared sqlite/pg table builder — pg-core's `pgTable` and
 * sqlite-core's `sqliteTable` are different modules with different column
 * functions. The shared layer therefore lives at the metadata level: enum
 * tuples, type unions, and table/index name strings that both physical
 * schemas import. Drift between the two schemas is caught by
 * `src/db/schema/drift.test.ts` (acceptance #6).
 *
 * Repos and consumers continue to import from `../db/schema.ts`, which
 * re-exports these constants alongside the SQLite tables (today's runtime).
 * Step 3 (warren-a66e) adds dialect-aware `openDatabase`; until then, the
 * Postgres tables exist but are unused at runtime.
 */

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

/**
 * Physical table names. Centralized so the two dialect modules and the drift
 * check stay in lockstep — renaming a table is a one-line change here.
 */
export const TABLE_NAMES = {
	agents: "agents",
	projects: "projects",
	runs: "runs",
	events: "events",
	triggers: "triggers",
	workers: "workers",
	burrows: "burrows",
} as const;

/**
 * Physical index names. The drift check matches on these strings exactly;
 * if a new index is added to one dialect it must be added to the other with
 * the same name and column list.
 */
export const INDEX_NAMES = {
	projectsGitUrl: "projects_git_url_idx",
	runsState: "runs_state_idx",
	runsProjectStarted: "runs_project_started_idx",
	runsAgentStarted: "runs_agent_started_idx",
	runsWorkerState: "runs_worker_state_idx",
	eventsRunSeq: "events_run_seq_idx",
	eventsRunTs: "events_run_ts_idx",
	triggersProject: "triggers_project_idx",
	burrowsWorker: "burrows_worker_idx",
} as const;

/**
 * Build the composite PK from a project + trigger pair. The colon separator
 * matches the plan's `<projectId>:<triggerId>` shape so a row key can be read
 * back into its components without consulting the columns.
 */
export function makeTriggerRowId(projectId: string, triggerId: string): string {
	return `${projectId}:${triggerId}`;
}
