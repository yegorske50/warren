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
import type { DrizzleDb } from "../client.ts";
import { type AgentRow, agents } from "../schema.ts";

export interface UpsertAgentInput {
	name: string;
	renderedJson: unknown;
	now?: Date;
}

export class AgentsRepo {
	constructor(private readonly db: DrizzleDb) {}

	async upsert(input: UpsertAgentInput): Promise<AgentRow> {
		const ts = (input.now ?? new Date()).toISOString();
		return this.db.transaction((tx) => {
			const existing = tx.select().from(agents).where(eq(agents.name, input.name)).get();
			if (existing) {
				const patch = {
					renderedJson: input.renderedJson,
					lastRefreshed: ts,
				};
				tx.update(agents).set(patch).where(eq(agents.name, input.name)).run();
				return { ...existing, ...patch };
			}
			const row: AgentRow = {
				name: input.name,
				renderedJson: input.renderedJson,
				registeredAt: ts,
				lastRefreshed: ts,
			};
			tx.insert(agents).values(row).run();
			return row;
		});
	}

	async get(name: string): Promise<AgentRow | null> {
		return this.db.select().from(agents).where(eq(agents.name, name)).get() ?? null;
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
		return this.db.select().from(agents).orderBy(asc(agents.name)).all();
	}

	async delete(name: string): Promise<void> {
		this.db.delete(agents).where(eq(agents.name, name)).run();
	}
}
