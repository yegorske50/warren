/**
 * Errors specific to the seeds CLI shell-out facade.
 *
 * `SeedsCliError` covers failures shelling out to `sd` against a project
 * clone (binary missing, non-zero exit, malformed JSON). Callers (the
 * tick loop, the post-dispatch updateExtensions write) catch it
 * per-project / per-run so one broken `.seeds/` doesn't kill the
 * surrounding flow.
 */

import { WarrenError } from "../core/errors.ts";

export class SeedsCliError extends WarrenError {
	readonly code: string = "seeds_cli_error";
}

/**
 * Definitive "this seed/plan does not exist" failure (warren-0fed). Thrown
 * by `showSeed` / `showPlan` when `sd` exits non-zero with a "not found"
 * message, so callers can distinguish a terminal missing-id case (fail the
 * plan-run) from a transient `sd` failure (timeout, lock — retryable).
 * Subclasses `SeedsCliError` so existing `instanceof SeedsCliError` callers
 * keep matching.
 */
export class SeedNotFoundError extends SeedsCliError {
	override readonly code = "seed_not_found";
}
