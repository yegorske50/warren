/**
 * Worker placement (warren-135b / pl-9ba1 step 2, parent warren-6747).
 *
 * Two entry points, both pure functions of warren's repo state — they do not
 * dispatch to burrow themselves. `BurrowClientPool` (step 3) maps the worker
 * name returned here onto a real `BurrowClient`; the spawn flow (step 4)
 * threads `placeFor` into `provisionBurrow` and writes the result onto
 * `runs.worker_id` + `burrows.worker_id` so the routing decision is durable.
 *
 *   - {@link placeForProject} — picks a worker for a new burrow. Two-tier:
 *     (A) project-affinity / warm-clone: the worker that hosted this
 *         project's most-recent successful run, if it is `healthy`.
 *         A run on a `draining` worker still finishes, but new placement
 *         won't follow affinity onto a draining worker — falls through to
 *         (B) so the next dispatch lands fresh capacity.
 *     (B) least-loaded by in-flight (`queued` + `running`) run count across
 *         `healthy` workers, alphabetical tiebreak by name. `draining` and
 *         `unreachable` workers are excluded entirely from (B).
 *
 *   - {@link placeForBurrow} — sticky-by-burrow for an existing burrow.
 *     Reads `burrows.worker_id` directly and returns it as long as the
 *     worker is `healthy` or `draining` (a draining worker keeps serving
 *     existing burrows until they finish, plan acceptance #3). An
 *     `unreachable` worker raises `StickyWorkerUnreachableError` — warren
 *     fails the request loudly rather than silently re-placing the burrow
 *     on another worker (plan risk #5; orphaned `burrows.worker_id` rows
 *     are surfaced by `warren doctor` as `worker_missing`).
 *
 * Both raise `NoEligibleWorkerError` when there is nothing to place onto,
 * which the HTTP layer surfaces as a structured error to the caller.
 *
 * Zero-config single-worker note: the synthetic local worker
 * `BurrowClientPool` (step 3) materializes from `WARREN_BURROW_*` env vars
 * lives in the `workers` table as a `healthy` row named `local` (step 3
 * inserts it at boot if absent). Placement in that deploy is therefore a
 * trivial pick-the-only-healthy-worker — affinity and load are no-ops with
 * one row. This module makes no special case for it.
 */

import { WarrenError } from "../core/errors.ts";
import type { Repos } from "../db/repos/index.ts";
import type { WorkerRow } from "../db/schema.ts";

export class NoEligibleWorkerError extends WarrenError {
	readonly code = "no_eligible_worker";
}

export class StickyWorkerUnreachableError extends WarrenError {
	readonly code = "sticky_worker_unreachable";
}

export interface PlacementDeps {
	readonly repos: Repos;
}

export interface PlaceForProjectInput {
	readonly projectId: string;
}

export interface PlaceForBurrowInput {
	readonly burrowId: string;
}

/**
 * Pick a worker for a fresh burrow. See module doc for the two-tier rule.
 * Returns the worker name; the caller resolves it to a `BurrowClient` via
 * `BurrowClientPool` (step 3).
 */
export async function placeForProject(
	deps: PlacementDeps,
	input: PlaceForProjectInput,
): Promise<string> {
	const all = await deps.repos.workers.listAll();
	const healthy = all.filter((w) => w.state === "healthy");
	if (healthy.length === 0) {
		throw new NoEligibleWorkerError(
			"no healthy workers available for placement: all workers are draining or unreachable",
			{
				recoveryHint:
					"check `GET /workers` for state; bring a worker back to healthy or add capacity",
			},
		);
	}

	const affinity = await projectAffinity(deps, input.projectId, healthy);
	if (affinity !== null) return affinity;

	return leastLoaded(deps, healthy);
}

/**
 * Look up the worker that owns an existing burrow. Sticky-by-burrow: no
 * re-placement, no migration. Raises if the burrow is not in `burrows` or
 * its worker is `unreachable`. `draining` is OK — see module doc.
 */
export async function placeForBurrow(
	deps: PlacementDeps,
	input: PlaceForBurrowInput,
): Promise<string> {
	const burrow = await deps.repos.burrows.get(input.burrowId);
	if (burrow === null) {
		throw new NoEligibleWorkerError(`burrow has no placement record: ${input.burrowId}`, {
			recoveryHint:
				"warren has no `burrows` row for this id; it may have been provisioned before multi-worker placement landed (pl-9ba1)",
		});
	}
	const worker = await deps.repos.workers.get(burrow.workerId);
	if (worker === null) {
		throw new StickyWorkerUnreachableError(
			`burrow ${input.burrowId} is pinned to unknown worker '${burrow.workerId}'`,
			{
				recoveryHint:
					"the worker row is gone; either re-add it to `[workers]` config or accept the orphan and let `warren doctor` flag it",
			},
		);
	}
	if (worker.state === "unreachable") {
		throw new StickyWorkerUnreachableError(
			`burrow ${input.burrowId} is pinned to unreachable worker '${worker.name}'`,
			{
				recoveryHint:
					"wait for the probe to flip the worker back to healthy, or drain + remove it so warren doctor surfaces the orphaned burrow",
			},
		);
	}
	return burrow.workerId;
}

async function projectAffinity(
	deps: PlacementDeps,
	projectId: string,
	healthy: readonly WorkerRow[],
): Promise<string | null> {
	const recent = await deps.repos.runs.mostRecentSucceededWithWorker(projectId);
	if (recent === null || recent.workerId === null) return null;
	const stickyWorker = healthy.find((w) => w.name === recent.workerId);
	return stickyWorker?.name ?? null;
}

async function leastLoaded(deps: PlacementDeps, healthy: readonly WorkerRow[]): Promise<string> {
	const load = await deps.repos.runs.countInflightByWorker();
	const ranked = healthy
		.map((w) => ({ name: w.name, load: load.get(w.name) ?? 0 }))
		.sort((a, b) => a.load - b.load || a.name.localeCompare(b.name));
	// healthy.length is non-zero (caller checked), so [0] is defined.
	const head = ranked[0];
	if (head === undefined) {
		// unreachable in practice — `healthy` is non-empty above. Defensive
		// branch for noUncheckedIndexedAccess.
		throw new NoEligibleWorkerError("no healthy worker after load ranking");
	}
	return head.name;
}
