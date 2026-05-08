/**
 * Live registry of `bridgeRunStream` controllers.
 *
 * The HTTP server boots, walks the runs table for (queued|running) rows
 * that have a `burrow_run_id`, and attaches a bridge to each — that's
 * the §9 "MAX(events.burrow_event_seq)+1 on warren restart" recovery.
 * Every subsequent `POST /runs` registers a new bridge for the spawned
 * run via `start()`. On shutdown, `stopAll()` aborts everyone in one
 * pass and awaits the drain so the events table stays consistent with
 * the burrow stream cursor.
 *
 * Idempotent against double-start: registering a runId that already has
 * an in-flight bridge is a no-op. That keeps recovery safe to re-run
 * (e.g. supervisor restart that races with a still-being-recorded
 * `POST /runs`).
 *
 * The registry stays small (one entry per active run); resolved bridges
 * remove themselves automatically so a long-lived server doesn't grow
 * unbounded. Tests inject a stub bridge factory to avoid a real burrow.
 */

import type { BurrowClient } from "../burrow-client/client.ts";
import type { Repos } from "../db/repos/index.ts";
import {
	type BridgeLogger,
	type BridgeRunStreamInput,
	type BridgeRunStreamResult,
	bridgeRunStream,
	type RunEventBroker,
} from "../runs/index.ts";
import type { BridgeRegistry } from "./types.ts";

interface BridgeEntry {
	readonly burrowRunId: string;
	readonly abort: AbortController;
	readonly done: Promise<BridgeRunStreamResult>;
}

export interface CreateBridgeRegistryInput {
	readonly repos: Repos;
	readonly broker: RunEventBroker;
	readonly burrowClient: BurrowClient;
	readonly logger?: BridgeLogger;
	/**
	 * Override the per-run bridge factory (tests). Defaults to the live
	 * `bridgeRunStream` from `../runs/`.
	 */
	readonly bridge?: (input: BridgeRunStreamInput) => Promise<BridgeRunStreamResult>;
}

export function createBridgeRegistry(input: CreateBridgeRegistryInput): BridgeRegistry {
	const live = new Map<string, BridgeEntry>();
	const bridge = input.bridge ?? bridgeRunStream;

	function start(runId: string, burrowRunId: string): void {
		if (live.has(runId)) return;
		const abort = new AbortController();
		const bridgeInput: BridgeRunStreamInput = {
			runId,
			burrowRunId,
			repos: input.repos,
			broker: input.broker,
			burrowClient: input.burrowClient,
			signal: abort.signal,
			...(input.logger !== undefined ? { logger: input.logger } : {}),
		};
		const done = bridge(bridgeInput);
		const entry: BridgeEntry = { burrowRunId, abort, done };
		live.set(runId, entry);
		void done.finally(() => {
			if (live.get(runId) === entry) live.delete(runId);
		});
	}

	async function stopAll(): Promise<void> {
		const entries = [...live.values()];
		for (const entry of entries) entry.abort.abort();
		await Promise.allSettled(entries.map((e) => e.done));
		live.clear();
	}

	return {
		start,
		stopAll,
		size: () => live.size,
	};
}

export interface BootBridgesResult {
	readonly registry: BridgeRegistry;
	readonly resumed: readonly { runId: string; burrowRunId: string }[];
	readonly skipped: readonly { runId: string; reason: string }[];
}

/**
 * Build a registry and prime it with bridges for every active run that
 * has a `burrow_run_id`. Active rows missing one are skipped — those
 * are partial spawns the spawn-rollback path should already have
 * cancelled. Surface them in `skipped` so the operator sees the count.
 */
export function bootBridges(input: CreateBridgeRegistryInput): BootBridgesResult {
	const registry = createBridgeRegistry(input);
	const candidates = input.repos.runs.listByState(["queued", "running"]);
	const resumed: { runId: string; burrowRunId: string }[] = [];
	const skipped: { runId: string; reason: string }[] = [];

	for (const run of candidates) {
		if (run.burrowRunId === null) {
			skipped.push({ runId: run.id, reason: "no_burrow_run_id" });
			input.logger?.warn?.(
				{ runId: run.id, state: run.state },
				"skipping recovery: run has no burrow_run_id",
			);
			continue;
		}
		registry.start(run.id, run.burrowRunId);
		resumed.push({ runId: run.id, burrowRunId: run.burrowRunId });
		input.logger?.info?.(
			{ runId: run.id, burrowRunId: run.burrowRunId, state: run.state },
			"resumed run stream bridge",
		);
	}

	return { registry, resumed, skipped };
}
