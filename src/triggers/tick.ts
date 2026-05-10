/**
 * Scheduler tick loop (R-06).
 *
 * One in-process tick fires every `tickMs` (default 60s), walks every
 * known project, and:
 *
 *   1. Loads `.warren/triggers.yaml` + `.warren/defaults.json` via the
 *      shared cache (R-02). Projects with no `.warren/` are skipped
 *      cheaply — the cache returns a `{triggers: null, defaults: null}`
 *      envelope and the loop is a no-op for them.
 *
 *   2. Dispatches cron entries via `dispatchCronTrigger`. No-catch-up
 *      semantics live in the dispatcher; the tick just feeds it `now`.
 *
 *   3. Shells out to `sd list --format json` for scheduled-for seeds and
 *      dispatches the past-due ones via `dispatchScheduledSeed`.
 *      Post-dispatch, calls `clearScheduledFor`; any failure here is
 *      surfaced as a `trigger.cleared_extension_failed` system event on
 *      the dispatched run so the operator sees the lingering extension
 *      without tailing logs (pl-2f15 risk #4).
 *
 * Single-flight: `startScheduler` wraps the tick callback in a guard
 * that drops overlapping ticks instead of stacking them. A slow tick
 * (many projects × slow burrow) degrades effective cadence but never
 * causes duplicate fires (pl-2f15 risk #5).
 *
 * Stop semantics: `startScheduler` returns a `stop()` that clears the
 * interval and waits for any in-flight tick to drain. bootServer wires
 * this into WarrenServerHandle.stop (R-06 step 4).
 */

import type { Repos } from "../db/repos/index.ts";
import type { ProjectRow } from "../db/schema.ts";
import type { LoadedWarrenConfig } from "../warren-config/index.ts";
import {
	type DispatchCronResult,
	type DispatchScheduledResult,
	type DispatchSpawnFn,
	dispatchCronTrigger,
	dispatchScheduledSeed,
} from "./dispatch.ts";
import type { ScheduledSeed } from "./schema.ts";

export type LoadWarrenConfigFn = (
	projectId: string,
	projectPath: string,
) => Promise<LoadedWarrenConfig>;

export type ListScheduledSeedsFn = (projectPath: string) => Promise<{
	scheduled: readonly ScheduledSeed[];
	errors: readonly { seedId: string; message: string }[];
}>;

export type ClearScheduledForFn = (
	projectPath: string,
	seedId: string,
	runId: string,
) => Promise<void>;

export interface TickLogger {
	info(obj: Record<string, unknown>, msg?: string): void;
	warn(obj: Record<string, unknown>, msg?: string): void;
	error(obj: Record<string, unknown>, msg?: string): void;
}

export interface TickDeps {
	readonly repos: Pick<Repos, "projects" | "triggers" | "runs" | "events">;
	readonly loadWarrenConfig: LoadWarrenConfigFn;
	readonly listScheduledSeeds: ListScheduledSeedsFn;
	readonly clearScheduledFor: ClearScheduledForFn;
	readonly spawn: DispatchSpawnFn;
	readonly now?: () => Date;
	readonly logger?: TickLogger;
}

export interface RunTickResult {
	readonly cron: readonly DispatchCronResult[];
	readonly scheduled: readonly DispatchScheduledResult[];
	readonly projectErrors: readonly { projectId: string; reason: string }[];
}

/**
 * Run one pass over every project. Returned for tests/diagnostics; the
 * production interval (`startScheduler`) discards the value but logs the
 * outcome via the logger.
 */
export async function runTick(deps: TickDeps): Promise<RunTickResult> {
	const now = deps.now?.() ?? new Date();
	const cron: DispatchCronResult[] = [];
	const scheduled: DispatchScheduledResult[] = [];
	const projectErrors: { projectId: string; reason: string }[] = [];

	for (const project of deps.repos.projects.listAll()) {
		try {
			await runProjectTick({
				deps,
				project,
				now,
				cron,
				scheduled,
			});
		} catch (err) {
			// pl-2f15 risk #9: project delete races with the tick can leave
			// stale rows in flight. Catch per-project so one bad row can't
			// derail the rest of the tick.
			const reason = formatError(err);
			projectErrors.push({ projectId: project.id, reason });
			deps.logger?.error({ projectId: project.id, reason }, "scheduler.project_failed");
		}
	}

	return { cron, scheduled, projectErrors };
}

interface RunProjectTickInput {
	readonly deps: TickDeps;
	readonly project: ProjectRow;
	readonly now: Date;
	readonly cron: DispatchCronResult[];
	readonly scheduled: DispatchScheduledResult[];
}

async function runProjectTick(input: RunProjectTickInput): Promise<void> {
	const { deps, project, now, cron, scheduled } = input;
	const config = await deps.loadWarrenConfig(project.id, project.localPath);

	// Surface .warren/ parse errors at info-level — the GET /warren-config
	// surface already exposes them, and we don't want every tick to
	// re-warn for the same broken file.
	if (config.errors.length > 0) {
		deps.logger?.info(
			{ projectId: project.id, count: config.errors.length },
			"scheduler.warren_config_errors",
		);
	}

	for (const trigger of config.triggers ?? []) {
		const result = await dispatchCronTrigger({
			projectId: project.id,
			trigger,
			defaults: config.defaults,
			now,
			repos: deps.repos,
			spawn: deps.spawn,
		});
		cron.push(result);
		logCronResult(deps.logger, project.id, trigger.id, result);
	}

	let seedsResult: Awaited<ReturnType<ListScheduledSeedsFn>>;
	try {
		seedsResult = await deps.listScheduledSeeds(project.localPath);
	} catch (err) {
		// pl-2f15 risk #4: shell-out failures must not double-dispatch on
		// the next tick. We never wrote a warren-side row for these seeds,
		// so retrying on the next tick is correct.
		deps.logger?.warn(
			{ projectId: project.id, reason: formatError(err) },
			"scheduler.sd_list_failed",
		);
		return;
	}

	for (const err of seedsResult.errors) {
		deps.logger?.warn(
			{ projectId: project.id, seedId: err.seedId, reason: err.message },
			"scheduler.scheduled_for_parse_error",
		);
	}

	for (const seed of seedsResult.scheduled) {
		const result = await dispatchScheduledSeed({
			projectId: project.id,
			seed,
			defaults: config.defaults,
			now,
			spawn: deps.spawn,
		});
		scheduled.push(result);
		logScheduledResult(deps.logger, project.id, result);

		if (result.kind === "fired") {
			// Risk #4: write-once semantics. We dispatched the seed; even if
			// the clear fails, the run id is in seed extensions via
			// lastScheduledRun ONLY if the clear succeeds. If it fails we
			// stamp a system event on the run so the operator sees the
			// lingering scheduledFor without tailing logs.
			try {
				await deps.clearScheduledFor(project.localPath, result.seedId, result.runId);
			} catch (err) {
				recordClearFailure(deps, result.runId, result.seedId, formatError(err));
			}
		}
	}
}

function logCronResult(
	logger: TickLogger | undefined,
	projectId: string,
	triggerId: string,
	result: DispatchCronResult,
): void {
	if (result.kind === "fired") {
		logger?.info(
			{ projectId, triggerId, runId: result.runId, nextFireAt: result.nextFireAt?.toISOString() },
			"scheduler.cron_fired",
		);
	} else if (result.kind === "error") {
		logger?.warn({ projectId, triggerId, reason: result.reason }, "scheduler.cron_failed");
	}
}

function logScheduledResult(
	logger: TickLogger | undefined,
	projectId: string,
	result: DispatchScheduledResult,
): void {
	if (result.kind === "fired") {
		logger?.info(
			{ projectId, seedId: result.seedId, runId: result.runId },
			"scheduler.scheduled_fired",
		);
	} else if (result.kind === "error") {
		logger?.warn(
			{ projectId, seedId: result.seedId, reason: result.reason },
			"scheduler.scheduled_failed",
		);
	}
}

function recordClearFailure(deps: TickDeps, runId: string, seedId: string, reason: string): void {
	try {
		const seq = (deps.repos.events.maxSeqForRun(runId) ?? 0) + 1;
		const now = deps.now?.() ?? new Date();
		deps.repos.events.append({
			runId,
			burrowEventSeq: seq,
			ts: now.toISOString(),
			kind: "trigger.cleared_extension_failed",
			stream: "system",
			payload: { seedId, reason },
		});
	} catch (err) {
		deps.logger?.error(
			{ runId, seedId, reason: formatError(err) },
			"scheduler.system_event_failed",
		);
	}
	deps.logger?.warn({ runId, seedId, reason }, "scheduler.clear_scheduled_for_failed");
}

/**
 * Opaque handle returned by setInterval. Both Node and Bun return their
 * own `Timeout`/`Timer` type plus a numeric overload; widening to the
 * intersection here means tests can stub with either side without the
 * type system caring.
 */
export type SchedulerTimerHandle = object;

export interface StartSchedulerInput extends TickDeps {
	readonly tickMs: number;
	readonly disabled?: boolean;
	/** Used by tests to override the timer plumbing. */
	readonly setInterval?: (cb: () => void, ms: number) => SchedulerTimerHandle;
	readonly clearInterval?: (handle: SchedulerTimerHandle) => void;
}

export interface SchedulerHandle {
	stop(): Promise<void>;
	/** Test seam — fire one tick synchronously, awaiting completion. */
	runOnce(): Promise<RunTickResult | null>;
	/** Test/diagnostic surface — number of ticks completed (success or skip). */
	tickCount(): number;
}

// Marker handle returned when the scheduler is disabled. Cast through
// unknown because there's no public way to manufacture the platform's
// Timer/Timeout type without actually scheduling something.
const NOOP_HANDLE = Symbol("noop-scheduler-handle") as unknown as SchedulerTimerHandle;

/**
 * Boot the recurring tick loop. When `disabled` is true the scheduler is
 * a no-op handle — bootServer can wire this unconditionally without an
 * env-var branch in the boot code path.
 *
 * Single-flight: a tick in progress when the next interval fires is
 * skipped (logged as `scheduler.tick_skipped`). The next interval picks
 * up against fresh state.
 */
export function startScheduler(input: StartSchedulerInput): SchedulerHandle {
	const setIntervalFn: (cb: () => void, ms: number) => SchedulerTimerHandle =
		input.setInterval ?? ((cb, ms) => globalThis.setInterval(cb, ms) as SchedulerTimerHandle);
	const clearIntervalFn: (handle: SchedulerTimerHandle) => void =
		input.clearInterval ?? ((handle) => globalThis.clearInterval(handle as never));

	let inFlight: Promise<RunTickResult | null> | null = null;
	let ticks = 0;
	let stopped = false;

	const fire = async (): Promise<RunTickResult | null> => {
		if (stopped) return null;
		if (inFlight !== null) {
			input.logger?.info({}, "scheduler.tick_skipped");
			return null;
		}
		const promise = (async () => {
			try {
				const result = await runTick(input);
				ticks += 1;
				return result;
			} catch (err) {
				input.logger?.error({ reason: formatError(err) }, "scheduler.tick_failed");
				return null;
			} finally {
				inFlight = null;
			}
		})();
		inFlight = promise;
		return promise;
	};

	const handle: SchedulerTimerHandle =
		input.disabled === true ? NOOP_HANDLE : setIntervalFn(() => void fire(), input.tickMs);

	return {
		async stop() {
			stopped = true;
			if (handle !== NOOP_HANDLE) clearIntervalFn(handle);
			if (inFlight !== null) {
				try {
					await inFlight;
				} catch {
					// Already logged inside fire().
				}
			}
		},
		runOnce: fire,
		tickCount: () => ticks,
	};
}

function formatError(err: unknown): string {
	if (err instanceof Error) return err.message;
	return String(err);
}
