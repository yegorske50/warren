/**
 * Repository for the `triggers` table (R-06 scheduler state).
 *
 * The trigger definitions themselves live in each project's
 * `.warren/triggers.yaml` and are parsed by `src/warren-config/` (R-02).
 * This repo only owns the mutable scheduler bookkeeping warren needs to
 * survive restarts: when each trigger last fired, when the scheduler
 * computed its next fire, and the most recent run id dispatched for it.
 *
 * Rows are keyed by a composite `<projectId>:<triggerId>` string PK so the
 * tick loop can write back state without juggling a generated id — the
 * trigger's authoring identity in YAML is the durable handle. `upsert` is
 * the only write path the scheduler needs: each tick the dispatcher passes
 * the freshly-computed next-fire-at (and on a fire, the last-fired-at +
 * last-run-id), and existing rows are merged in place.
 */

import { asc, eq } from "drizzle-orm";
import { NotFoundError } from "../../core/errors.ts";
import type { DrizzleDb } from "../client.ts";
import { makeTriggerRowId, type TriggerRow, triggers } from "../schema.ts";

export interface TriggerKey {
	projectId: string;
	triggerId: string;
}

export interface UpsertTriggerInput extends TriggerKey {
	lastFiredAt?: string | null;
	nextFireAt?: string | null;
	lastRunId?: string | null;
}

export interface RecordFireInput extends TriggerKey {
	firedAt: Date;
	nextFireAt: Date | null;
	runId: string;
}

export class TriggersRepo {
	constructor(private readonly db: DrizzleDb) {}

	/**
	 * Insert-or-merge a scheduler row. Fields omitted from the patch keep
	 * their existing values — the scheduler may write a fresh next-fire-at
	 * across many ticks without disturbing last-fired-at / last-run-id from
	 * the most recent dispatch.
	 */
	async upsert(input: UpsertTriggerInput): Promise<TriggerRow> {
		return this.db.transaction((tx) => {
			const id = makeTriggerRowId(input.projectId, input.triggerId);
			const existing = tx.select().from(triggers).where(eq(triggers.id, id)).get();
			if (existing) {
				const patch: Partial<TriggerRow> = {};
				if (input.lastFiredAt !== undefined) patch.lastFiredAt = input.lastFiredAt;
				if (input.nextFireAt !== undefined) patch.nextFireAt = input.nextFireAt;
				if (input.lastRunId !== undefined) patch.lastRunId = input.lastRunId;
				if (Object.keys(patch).length === 0) return existing;
				tx.update(triggers).set(patch).where(eq(triggers.id, id)).run();
				return { ...existing, ...patch };
			}
			const row: TriggerRow = {
				id,
				projectId: input.projectId,
				triggerId: input.triggerId,
				lastFiredAt: input.lastFiredAt ?? null,
				nextFireAt: input.nextFireAt ?? null,
				lastRunId: input.lastRunId ?? null,
			};
			tx.insert(triggers).values(row).run();
			return row;
		});
	}

	/**
	 * Convenience writer for the dispatcher path: stamp lastFiredAt to the
	 * fire timestamp, lastRunId to the dispatched run, and roll nextFireAt
	 * forward in a single transaction so the next tick sees a consistent
	 * row (no half-state where the run is recorded but next-fire still
	 * points at the past).
	 */
	async recordFire(input: RecordFireInput): Promise<TriggerRow> {
		return this.upsert({
			projectId: input.projectId,
			triggerId: input.triggerId,
			lastFiredAt: input.firedAt.toISOString(),
			nextFireAt: input.nextFireAt ? input.nextFireAt.toISOString() : null,
			lastRunId: input.runId,
		});
	}

	async get(key: TriggerKey): Promise<TriggerRow | null> {
		const id = makeTriggerRowId(key.projectId, key.triggerId);
		return this.db.select().from(triggers).where(eq(triggers.id, id)).get() ?? null;
	}

	async require(key: TriggerKey): Promise<TriggerRow> {
		const row = await this.get(key);
		if (!row) {
			throw new NotFoundError(
				`trigger not found: ${makeTriggerRowId(key.projectId, key.triggerId)}`,
			);
		}
		return row;
	}

	async listByProject(projectId: string): Promise<TriggerRow[]> {
		return this.db
			.select()
			.from(triggers)
			.where(eq(triggers.projectId, projectId))
			.orderBy(asc(triggers.triggerId))
			.all();
	}

	async listAll(): Promise<TriggerRow[]> {
		return this.db
			.select()
			.from(triggers)
			.orderBy(asc(triggers.projectId), asc(triggers.triggerId))
			.all();
	}

	async delete(key: TriggerKey): Promise<void> {
		const id = makeTriggerRowId(key.projectId, key.triggerId);
		this.db.delete(triggers).where(eq(triggers.id, id)).run();
	}
}
