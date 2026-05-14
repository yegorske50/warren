/**
 * Repository for the `workers` table (warren-b0a3 / pl-9ba1 step 1, parent
 * warren-6747).
 *
 * Each row is a burrow worker the `BurrowClientPool` (step 3) can dispatch to.
 * `name` is the operator-chosen handle and the URL identity used by
 * `POST /workers/:name/drain`; `url` is the transport target consumed by
 * `HttpClient`. The bearer token is shared across the pool via the single
 * `BURROW_API_TOKEN` env var (plan alternative #3) — it is intentionally NOT
 * stored here.
 *
 * This repo only owns the row layer. State transitions (probe → healthy /
 * unreachable, drain → draining) and placement decisions land in steps 3 and
 * 6 atop these primitives. `upsert` matches the loader semantics for step 7:
 * the warren-config `[workers]` block re-materializes rows at boot, and
 * existing rows' `state` is preserved across reloads (operators can drain a
 * worker without warren clobbering that state on the next config sync).
 */

import { asc, eq } from "drizzle-orm";
import { NotFoundError } from "../../core/errors.ts";
import type { DrizzleDb } from "../client.ts";
import { type WorkerRow, type WorkerState, workers } from "../schema.ts";

export interface UpsertWorkerInput {
	name: string;
	url: string;
	state?: WorkerState;
	now?: Date;
}

export class WorkersRepo {
	constructor(private readonly db: DrizzleDb) {}

	/**
	 * Insert-or-merge a worker row. New rows take the supplied `state`
	 * (default `healthy`) and stamp `addedAt`. Existing rows update `url`
	 * (operators can re-point a worker without losing its `addedAt` /
	 * probe-derived state) and only update `state` when the caller passes
	 * one — config-driven reloads (step 7) omit `state` so the probe loop
	 * (step 6) stays the source of truth for liveness.
	 */
	async upsert(input: UpsertWorkerInput): Promise<WorkerRow> {
		return this.db.transaction((tx) => {
			const existing = tx.select().from(workers).where(eq(workers.name, input.name)).get();
			if (existing) {
				const patch: Partial<WorkerRow> = { url: input.url };
				if (input.state !== undefined) patch.state = input.state;
				tx.update(workers).set(patch).where(eq(workers.name, input.name)).run();
				return { ...existing, ...patch };
			}
			const row: WorkerRow = {
				name: input.name,
				url: input.url,
				state: input.state ?? "healthy",
				addedAt: (input.now ?? new Date()).toISOString(),
			};
			tx.insert(workers).values(row).run();
			return row;
		});
	}

	async setState(name: string, state: WorkerState): Promise<WorkerRow> {
		this.db.update(workers).set({ state }).where(eq(workers.name, name)).run();
		return this.require(name);
	}

	async get(name: string): Promise<WorkerRow | null> {
		return this.db.select().from(workers).where(eq(workers.name, name)).get() ?? null;
	}

	async require(name: string): Promise<WorkerRow> {
		const row = await this.get(name);
		if (!row) {
			throw new NotFoundError(`worker not found: ${name}`, {
				recoveryHint: "GET /workers to list known names",
			});
		}
		return row;
	}

	async listAll(): Promise<WorkerRow[]> {
		return this.db.select().from(workers).orderBy(asc(workers.name)).all();
	}

	async delete(name: string): Promise<void> {
		this.db.delete(workers).where(eq(workers.name, name)).run();
	}
}
