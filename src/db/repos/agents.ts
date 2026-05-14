/**
 * Repository for the `agents` table.
 *
 * Agents are canopy prompts cached locally — keyed by prompt name. `upsert`
 * is the registry-refresh path: re-rendering an existing agent overwrites
 * its rendered_json and bumps last_refreshed without losing the original
 * registered_at timestamp.
 */

import { asc, eq } from "drizzle-orm";
import { NotFoundError } from "../../core/errors.ts";
import type { SqliteDrizzleDb } from "../client.ts";
import type { AgentRow } from "../schema.ts";
import type { DrizzleAdapter } from "./drizzle-adapter.ts";

export interface UpsertAgentInput {
	name: string;
	renderedJson: unknown;
	now?: Date;
}

export class AgentsRepo {
	constructor(private readonly adapter: DrizzleAdapter) {}

	/**
	 * The repo casts `adapter.drizzle` to `SqliteDrizzleDb` to satisfy
	 * TypeScript — drizzle's per-dialect query builders share method names
	 * (`.select()`, `.insert()`, `.update()`, `.delete()`) but their return
	 * types are mutually incompatible at the union level. At runtime the
	 * handle is the dialect-correct drizzle handle paired with the
	 * dialect-correct schema (see `DrizzleAdapter.schema`), so the queries
	 * built here generate the correct dialect SQL.
	 */
	private get db(): SqliteDrizzleDb {
		return this.adapter.drizzle as SqliteDrizzleDb;
	}

	private get agents() {
		return this.adapter.schema.agents;
	}

	async upsert(input: UpsertAgentInput): Promise<AgentRow> {
		const ts = (input.now ?? new Date()).toISOString();
		return this.adapter.runInTransaction(async (tx) => {
			const txDb = tx.drizzle as SqliteDrizzleDb;
			const agents = tx.schema.agents;
			const existing = await tx.pickOne(
				txDb.select().from(agents).where(eq(agents.name, input.name)),
			);
			if (existing) {
				const patch = {
					renderedJson: input.renderedJson,
					lastRefreshed: ts,
				};
				await tx.runWrite(txDb.update(agents).set(patch).where(eq(agents.name, input.name)));
				return { ...existing, ...patch };
			}
			const row: AgentRow = {
				name: input.name,
				renderedJson: input.renderedJson,
				registeredAt: ts,
				lastRefreshed: ts,
			};
			await tx.runWrite(txDb.insert(agents).values(row));
			return row;
		});
	}

	async get(name: string): Promise<AgentRow | null> {
		const row = await this.adapter.pickOne(
			this.db.select().from(this.agents).where(eq(this.agents.name, name)),
		);
		return row ?? null;
	}

	async require(name: string): Promise<AgentRow> {
		const row = await this.get(name);
		if (!row) {
			throw new NotFoundError(`agent not found: ${name}`, {
				recoveryHint: "POST /agents/refresh to re-discover from canopy",
			});
		}
		return row;
	}

	async listAll(): Promise<AgentRow[]> {
		return this.adapter.pickAll(this.db.select().from(this.agents).orderBy(asc(this.agents.name)));
	}

	async delete(name: string): Promise<void> {
		await this.adapter.runWrite(this.db.delete(this.agents).where(eq(this.agents.name, name)));
	}
}
