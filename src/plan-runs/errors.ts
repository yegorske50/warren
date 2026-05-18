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
