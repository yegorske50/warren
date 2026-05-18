/**
 * Errors specific to the PlanRun coordinator (pl-a258 step 5 / warren-2623).
 *
 * `PlanRunDispatchError` covers failures inside a single PlanRun advance
 * that aren't already a typed warren error (NotFoundError, ValidationError,
 * StateTransitionError, RunSpawnError). It is per-PlanRun fatal — the tick
 * loop catches it so one bad row can't tear down the coordinator (mirrors
 * `TriggerDispatchError` in src/triggers/errors.ts).
 */

import { WarrenError } from "../core/errors.ts";

export class PlanRunDispatchError extends WarrenError {
	readonly code = "plan_run_dispatch_error";
}

/**
 * `POST /plan-runs` (warren-f923) rejection when the target project doesn't
 * carry a `.seeds/` directory (`project.hasSeeds === false`). Mirrors the
 * plot reject shape at warren-a8c3: 400 status, stable code so HTTP
 * consumers branch on it without parsing the message. Mapped to 400 in
 * src/server/errors.ts alongside ValidationError.
 */
export class ProjectLacksSeedsError extends WarrenError {
	readonly code = "project_lacks_seeds";
}

/**
 * `POST /plan-runs` (warren-f923) rejection when the target plan has no
 * open child seeds — every child is already closed, so the coordinator
 * would immediately succeed without dispatching anything. Same 400-status
 * posture as ProjectLacksSeedsError.
 */
export class PlanHasNoOpenChildrenError extends WarrenError {
	readonly code = "plan_has_no_open_children";
}
