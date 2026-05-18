/**
 * Read-time cost/token hydration for runs whose bridge died before its
 * next checkpoint (warren-ab18).
 *
 * The bridge (`stream.ts`) accumulates session usage in-memory and
 * checkpoints it onto `runs.cost_usd` / `runs.tokens_*` periodically
 * (pi: on every agent-end envelope; claude-code: on the terminal
 * `result` envelope). If warren stalls or the host reboots before the
 * next checkpoint lands, those columns stay null even though the
 * underlying usage envelopes were already persisted to `events`.
 *
 * `hydrateRunsUsage` patches that gap at read time: for any terminal
 * run whose `costUsd` is still null, it sums the run's usage events
 * via `aggregateUsageFromEvents` and overlays the derived totals onto
 * the row before the handler serializes it. Non-terminal rows are left
 * untouched — the bridge is the source of truth while it's alive.
 *
 * This is a transitional fallback only: a real fix would also backfill
 * the columns on terminal reconciliation so subsequent reads don't pay
 * the aggregation cost. The seed (warren-ab18) explicitly defers that
 * backfill — keep this helper focused on the symptom (operator sees
 * `-` for cost) and let the next iteration close the gap.
 */

import type { EventsRepo } from "../db/repos/events.ts";
import type { RunRow, RunState } from "../db/schema.ts";
import { aggregateUsageFromEvents, eventRowToUsageInput } from "./usage-aggregate.ts";

const TERMINAL_RUN_STATES: ReadonlySet<RunState> = new Set(["succeeded", "failed", "cancelled"]);

/**
 * Subset of `EventsRepo` used for hydration. Declared structurally so
 * tests can stub the events fetch without instantiating a full repo.
 */
export interface UsageEventsFetcher {
	listUsageEvents(
		runIds: readonly string[],
	): Promise<
		readonly { runId: string; kind: string; stream: string | null; payloadJson: unknown }[]
	>;
}

/**
 * For each run in `runs` that is terminal AND has `costUsd === null`,
 * compute usage from its persisted events and overlay the result onto
 * the row. Returns rows in the same order. Non-candidate rows are
 * passed through by reference (no spread).
 *
 * Batches all candidates into a single `listUsageEvents` call so the
 * list-endpoint case is one query, not N. Empty / no-candidate inputs
 * short-circuit without touching the DB.
 */
export async function hydrateRunsUsage<T extends RunRow>(
	runs: readonly T[],
	events: UsageEventsFetcher | EventsRepo,
): Promise<T[]> {
	const candidates = runs.filter(isHydrationCandidate);
	if (candidates.length === 0) return runs.slice();
	const rows = await events.listUsageEvents(candidates.map((r) => r.id));
	const byRun = new Map<string, (typeof rows)[number][]>();
	for (const row of rows) {
		const bucket = byRun.get(row.runId);
		if (bucket === undefined) byRun.set(row.runId, [row]);
		else bucket.push(row);
	}
	return runs.map((run) => {
		if (!isHydrationCandidate(run)) return run;
		const stats = aggregateUsageFromEvents((byRun.get(run.id) ?? []).map(eventRowToUsageInput));
		if (stats === null) return run;
		return {
			...run,
			costUsd: stats.costUsd,
			tokensInput: stats.tokensInput,
			tokensOutput: stats.tokensOutput,
			tokensCacheRead: stats.tokensCacheRead,
			tokensCacheWrite: stats.tokensCacheWrite,
		};
	});
}

/**
 * Single-row convenience wrapper around `hydrateRunsUsage`. Returns the
 * input row unchanged when it's not a hydration candidate.
 */
export async function hydrateRunUsage<T extends RunRow>(
	run: T,
	events: UsageEventsFetcher | EventsRepo,
): Promise<T> {
	const [hydrated] = await hydrateRunsUsage([run], events);
	// Length-1 input ⇒ length-1 output; non-null assertion is safe.
	return hydrated as T;
}

function isHydrationCandidate(run: RunRow): boolean {
	return run.costUsd === null && TERMINAL_RUN_STATES.has(run.state);
}
