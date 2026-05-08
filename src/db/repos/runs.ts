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

import { and, asc, desc, eq, inArray } from "drizzle-orm";
import { NotFoundError, StateTransitionError } from "../../core/errors.ts";
import { generateId } from "../../core/ids.ts";
import type { DrizzleDb } from "../client.ts";
import { type RunRow, type RunState, type RunTerminalState, runs } from "../schema.ts";

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
	now?: Date;
}

export interface AttachBurrowInput {
	burrowId: string;
	burrowRunId: string;
}

export class RunsRepo {
	constructor(private readonly db: DrizzleDb) {}

	create(input: CreateRunInput): RunRow {
		const row: RunRow = {
			id: input.id ?? generateId("run"),
			agentName: input.agentName,
			projectId: input.projectId,
			burrowId: input.burrowId ?? null,
			burrowRunId: input.burrowRunId ?? null,
			renderedAgentJson: input.renderedAgentJson,
			state: "queued",
			startedAt: null,
			endedAt: null,
			prompt: input.prompt,
			trigger: input.trigger,
		};
		this.db.insert(runs).values(row).run();
		return row;
	}

	get(id: string): RunRow | null {
		return this.db.select().from(runs).where(eq(runs.id, id)).get() ?? null;
	}

	require(id: string): RunRow {
		const row = this.get(id);
		if (!row) throw new NotFoundError(`run not found: ${id}`);
		return row;
	}

	listAll(limit = 100): RunRow[] {
		return this.db
			.select()
			.from(runs)
			.orderBy(desc(runs.startedAt), asc(runs.id))
			.limit(limit)
			.all();
	}

	listByProject(projectId: string, limit = 100): RunRow[] {
		return this.db
			.select()
			.from(runs)
			.where(eq(runs.projectId, projectId))
			.orderBy(desc(runs.startedAt), asc(runs.id))
			.limit(limit)
			.all();
	}

	listByAgent(agentName: string, limit = 100): RunRow[] {
		return this.db
			.select()
			.from(runs)
			.where(eq(runs.agentName, agentName))
			.orderBy(desc(runs.startedAt), asc(runs.id))
			.limit(limit)
			.all();
	}

	listByState(state: RunState | RunState[]): RunRow[] {
		const where = Array.isArray(state) ? inArray(runs.state, state) : eq(runs.state, state);
		return this.db.select().from(runs).where(where).orderBy(asc(runs.id)).all();
	}

	attachBurrow(id: string, input: AttachBurrowInput): RunRow {
		const current = this.require(id);
		const patch = {
			burrowId: input.burrowId,
			burrowRunId: input.burrowRunId,
		};
		this.db.update(runs).set(patch).where(eq(runs.id, id)).run();
		return { ...current, ...patch };
	}

	markRunning(id: string, now: Date = new Date()): RunRow {
		const current = this.require(id);
		assertRunTransition(current.state, "running");
		const patch = {
			state: "running" as const,
			startedAt: now.toISOString(),
		};
		this.db.update(runs).set(patch).where(eq(runs.id, id)).run();
		return { ...current, ...patch };
	}

	finalize(id: string, terminal: RunTerminalState, now: Date = new Date()): RunRow {
		const current = this.require(id);
		assertRunTransition(current.state, terminal);
		const patch = {
			state: terminal,
			endedAt: now.toISOString(),
		};
		this.db.update(runs).set(patch).where(eq(runs.id, id)).run();
		return { ...current, ...patch };
	}

	/**
	 * Atomic queued → running transition. Returns the claimed row, or null
	 * if the row no longer exists or is no longer in `queued`. Used to keep
	 * the warren-side state in sync with burrow's "the run loop just picked
	 * this up" observation.
	 */
	claimById(id: string, now: Date = new Date()): RunRow | null {
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
