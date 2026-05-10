/**
 * Re-export the persisted-state repo for the scheduler.
 *
 * `TriggersRepo` lives under `src/db/repos/` like every other table repo
 * (agents, projects, runs, events). The module-local file here exists so
 * `src/triggers/` callers don't reach across the package layout — every
 * other warren module follows the same pattern.
 */

export {
	type RecordFireInput,
	type TriggerKey,
	TriggersRepo,
	type UpsertTriggerInput,
} from "../db/repos/triggers.ts";
