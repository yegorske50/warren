/**
 * Repository for the `runs` table.
 *
 * Warren's run row mirrors the lifecycle of the underlying burrow run
 * (queued → running → succeeded|failed|cancelled). The state is updated as
 * we observe burrow's stream; warren itself does not pick runs off a queue.
 *
 * `attachBurrow` exists because the §4.3 composition flow creates the warren
 * row before burrow's `POST /burrows` and `POST /burrows/:id/runs` return —
 * the burrow IDs are written back once we have them.
 */

import { and, asc, desc, eq, inArray, isNotNull, sql } from "drizzle-orm";
import { NotFoundError, StateTransitionError, ValidationError } from "../../core/errors.ts";
import { generateId } from "../../core/ids.ts";
import type { DrizzleDb } from "../client.ts";
import {
	type RunFailureReason,
	type RunRow,
	type RunState,
	type RunTerminalState,
	runs,
} from "../schema.ts";

const ALLOWED_TRANSITIONS: Record<RunState, readonly RunState[]> = {
	queued: ["running", "cancelled"],
	running: ["succeeded", "failed", "cancelled"],
	succeeded: [],
	failed: [],
	cancelled: [],
};

export function assertRunTransition(from: RunState, to: RunState): void {
	if (!ALLOWED_TRANSITIONS[from].includes(to)) {
		throw new StateTransitionError(`invalid run transition: ${from} → ${to}`);
	}
}

export interface CreateRunInput {
	id?: string;
	agentName: string;
	projectId: string;
	prompt: string;
	renderedAgentJson: unknown;
	trigger: string;
	burrowId?: string | null;
	burrowRunId?: string | null;
	/**
	 * Worker that will host the burrow for this run (warren-135b). The
	 * spawn flow (pl-9ba1 step 4) resolves this via `placeFor` before
	 * provisioning and writes the denormalized id here so streaming /
	 * cancel / steer paths can route without joining `burrows`. Null on
	 * rows written before pl-9ba1 step 4 wired this in.
	 */
	workerId?: string | null;
	now?: Date;
}

export interface AttachBurrowInput {
	burrowId?: string;
	burrowRunId?: string;
	workerId?: string;
}

export interface AttachStatsInput {
	costUsd?: number | null;
	tokensInput?: number | null;
	tokensOutput?: number | null;
	tokensCacheRead?: number | null;
	tokensCacheWrite?: number | null;
}

export class RunsRepo {
	constructor(private readonly db: DrizzleDb) {}

	async create(input: CreateRunInput): Promise<RunRow> {
		const row: RunRow = {
			id: input.id ?? generateId("run"),
			agentName: input.agentName,
			projectId: input.projectId,
			burrowId: input.burrowId ?? null,
			burrowRunId: input.burrowRunId ?? null,
			workerId: input.workerId ?? null,
			renderedAgentJson: input.renderedAgentJson,
			state: "queued",
			failureReason: null,
			startedAt: null,
			endedAt: null,
			prompt: input.prompt,
			trigger: input.trigger,
			prUrl: null,
			costUsd: null,
			tokensInput: null,
			tokensOutput: null,
			tokensCacheRead: null,
			tokensCacheWrite: null,
		};
		this.db.insert(runs).values(row).run();
		return row;
	}

	async get(id: string): Promise<RunRow | null> {
		return this.db.select().from(runs).where(eq(runs.id, id)).get() ?? null;
	}

	async require(id: string): Promise<RunRow> {
		const row = await this.get(id);
		if (!row) throw new NotFoundError(`run not found: ${id}`);
		return row;
	}

	async listAll(limit = 100): Promise<RunRow[]> {
		return this.db
			.select()
			.from(runs)
			.orderBy(desc(runs.startedAt), asc(runs.id))
			.limit(limit)
			.all();
	}

	async listByProject(projectId: string, limit = 100): Promise<RunRow[]> {
		return this.db
			.select()
			.from(runs)
			.where(eq(runs.projectId, projectId))
			.orderBy(desc(runs.startedAt), asc(runs.id))
			.limit(limit)
			.all();
	}

	async listByAgent(agentName: string, limit = 100): Promise<RunRow[]> {
		return this.db
			.select()
			.from(runs)
			.where(eq(runs.agentName, agentName))
			.orderBy(desc(runs.startedAt), asc(runs.id))
			.limit(limit)
			.all();
	}

	async listByState(state: RunState | RunState[]): Promise<RunRow[]> {
		const where = Array.isArray(state) ? inArray(runs.state, state) : eq(runs.state, state);
		return this.db.select().from(runs).where(where).orderBy(asc(runs.id)).all();
	}

	/**
	 * Write back the burrow IDs as they become available. The §4.3 spawn flow
	 * provisions the burrow first (`POST /burrows`) and dispatches the run
	 * second (`POST /burrows/:id/runs`), so each ID lands on a different turn.
	 * Both fields are optional, but at least one must be set.
	 */
	async attachBurrow(id: string, input: AttachBurrowInput): Promise<RunRow> {
		if (
			input.burrowId === undefined &&
			input.burrowRunId === undefined &&
			input.workerId === undefined
		) {
			throw new ValidationError(
				"attachBurrow requires at least one of burrowId, burrowRunId, or workerId",
			);
		}
		const current = await this.require(id);
		const patch: { burrowId?: string; burrowRunId?: string; workerId?: string } = {};
		if (input.burrowId !== undefined) patch.burrowId = input.burrowId;
		if (input.burrowRunId !== undefined) patch.burrowRunId = input.burrowRunId;
		if (input.workerId !== undefined) patch.workerId = input.workerId;
		this.db.update(runs).set(patch).where(eq(runs.id, id)).run();
		return { ...current, ...patch };
	}

	async markRunning(id: string, now: Date = new Date()): Promise<RunRow> {
		const current = await this.require(id);
		assertRunTransition(current.state, "running");
		const patch = {
			state: "running" as const,
			startedAt: now.toISOString(),
		};
		this.db.update(runs).set(patch).where(eq(runs.id, id)).run();
		return { ...current, ...patch };
	}

	async finalize(
		id: string,
		terminal: RunTerminalState,
		now: Date = new Date(),
		failureReason: RunFailureReason | null = null,
	): Promise<RunRow> {
		const current = await this.require(id);
		assertRunTransition(current.state, terminal);
		const patch = {
			state: terminal,
			endedAt: now.toISOString(),
			failureReason: terminal === "failed" ? failureReason : null,
		};
		this.db.update(runs).set(patch).where(eq(runs.id, id)).run();
		return { ...current, ...patch };
	}

	/**
	 * Persist per-run cost + token accounting (warren-a7dc). All fields are
	 * optional patches — omitted fields preserve the existing value, explicit
	 * `null` clears it. Mirrors `attachBurrow`'s partial-input semantics so the
	 * bridge can land start-snapshot and end-snapshot writes on different turns
	 * without juggling intermediate state. Throws ValidationError if no fields
	 * were supplied, matching `attachBurrow`. The columns are nullable so
	 * non-pi runs (or pi runs whose stats RPC failed) leave them at null.
	 */
	async attachStats(id: string, input: AttachStatsInput): Promise<RunRow> {
		const keys: (keyof AttachStatsInput)[] = [
			"costUsd",
			"tokensInput",
			"tokensOutput",
			"tokensCacheRead",
			"tokensCacheWrite",
		];
		if (keys.every((k) => input[k] === undefined)) {
			throw new ValidationError("attachStats requires at least one stat field");
		}
		const current = await this.require(id);
		const patch: Partial<RunRow> = {};
		for (const k of keys) {
			if (input[k] !== undefined) {
				(patch as Record<string, number | null>)[k] = input[k] as number | null;
			}
		}
		this.db.update(runs).set(patch).where(eq(runs.id, id)).run();
		return { ...current, ...patch };
	}

	/**
	 * Persist the PR URL reap's `pr_open` sub-step opened (warren-f6af).
	 * Last write wins; passing `null` clears the field. Separate from
	 * `finalize` because reap fires this *before* the terminal transition
	 * (so the URL lands on the `reap.completed` event payload too).
	 */
	async setPrUrl(id: string, prUrl: string | null): Promise<RunRow> {
		const current = await this.require(id);
		this.db.update(runs).set({ prUrl }).where(eq(runs.id, id)).run();
		return { ...current, prUrl };
	}

	/**
	 * Project-affinity probe for `placeFor` (warren-135b / pl-9ba1 step 2):
	 * the most-recent run that succeeded against this project AND has a
	 * recorded `workerId`. Returns null if the project has no successful
	 * runs yet, or if no successful run was tagged with a worker (rows
	 * written before pl-9ba1 step 4 wired this in). Newest-first by
	 * `endedAt` so a recent run wins over an older one even if the older
	 * one started later in startedAt order.
	 */
	async mostRecentSucceededWithWorker(projectId: string): Promise<RunRow | null> {
		return (
			this.db
				.select()
				.from(runs)
				.where(
					and(eq(runs.projectId, projectId), eq(runs.state, "succeeded"), isNotNull(runs.workerId)),
				)
				.orderBy(desc(runs.endedAt), asc(runs.id))
				.limit(1)
				.get() ?? null
		);
	}

	/**
	 * In-flight load per worker for the least-loaded leg of `placeFor`
	 * (warren-135b / pl-9ba1 step 2). Counts `queued` + `running` runs
	 * grouped by `workerId`. Rows with a null `workerId` (legacy or
	 * unplaced) are excluded. Result is keyed by worker name; workers
	 * with zero in-flight runs are absent (the caller defaults to 0).
	 */
	async countInflightByWorker(): Promise<Map<string, number>> {
		const rows = this.db
			.select({
				workerId: runs.workerId,
				count: sql<number>`count(*)`.as("count"),
			})
			.from(runs)
			.where(and(isNotNull(runs.workerId), inArray(runs.state, ["queued", "running"])))
			.groupBy(runs.workerId)
			.all();
		const out = new Map<string, number>();
		for (const r of rows) {
			if (r.workerId !== null) out.set(r.workerId, Number(r.count));
		}
		return out;
	}

	/**
	 * Atomic queued → running transition. Returns the claimed row, or null
	 * if the row no longer exists or is no longer in `queued`. Used to keep
	 * the warren-side state in sync with burrow's "the run loop just picked
	 * this up" observation.
	 */
	async claimById(id: string, now: Date = new Date()): Promise<RunRow | null> {
		return this.db.transaction((tx) => {
			const row = tx.select().from(runs).where(eq(runs.id, id)).get();
			if (!row || row.state !== "queued") return null;
			const startedAt = now.toISOString();
			tx.update(runs)
				.set({ state: "running", startedAt })
				.where(and(eq(runs.id, id), eq(runs.state, "queued")))
				.run();
			return { ...row, state: "running", startedAt };
		});
	}
}
