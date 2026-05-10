/**
 * Errors specific to the R-06 scheduler module.
 *
 * `TriggerDispatchError` covers failures inside a single trigger dispatch
 * (cron-grammar parse failure, malformed seed reference) — recoverable
 * per-trigger, not fatal to the tick. The tick loop catches these so a
 * single bad entry can't take down the whole scheduler.
 *
 * `SeedsCliError` covers failures shelling out to `sd` against a project
 * clone (binary missing, non-zero exit, malformed JSON). Same posture —
 * caught per-project so one broken `.seeds/` doesn't kill the tick.
 *
 * Neither maps to an HTTP code today; the HTTP surface (R-06 step 5)
 * may surface these as per-trigger `lastSkipReason` strings, but at the
 * dispatch layer they're internal control flow.
 */

import { WarrenError } from "../core/errors.ts";

export class TriggerDispatchError extends WarrenError {
	readonly code = "trigger_dispatch_error";
}

export class SeedsCliError extends WarrenError {
	readonly code = "seeds_cli_error";
}
