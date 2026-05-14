/**
 * `refreshAgentRegistry` — the operation behind `POST /agents/refresh`
 * (SPEC §8.1) and `warren register-agent` (SPEC §8.2).
 *
 * Pipeline:
 *   1. Clone or fast-forward the canopy library repo on disk.
 *   2. List prompts tagged `agent` via `cn list --tag agent --json`.
 *   3. For each, render via `cn render <name> --format json`, validate
 *      against warren's semantic schema, and upsert into the agents
 *      table.
 *   4. Optionally prune agents that are no longer in the canopy repo
 *      (off by default — operators may not want a missed `git fetch`
 *      to nuke their registry).
 *
 * Per-agent failures are *collected*, not thrown: one bad prompt
 * shouldn't block the operator from seeing the other 19 register
 * cleanly. The caller decides whether to surface skipped entries as a
 * warning (UI) or as a non-zero CLI exit (`warren register-agent`).
 *
 * Transport-level failures (canopy unreachable, `cn` binary missing)
 * abort the whole refresh — there's nothing useful to partially register
 * if the registry is unreadable.
 */

import type { AgentsRepo } from "../db/repos/agents.ts";
import type { AgentRow } from "../db/schema.ts";
import type { AgentSummary, CanopyClient } from "./canopy.ts";
import { type CloneOptions, type CloneResult, cloneOrUpdateCanopyRepo } from "./clone.ts";
import { AgentSchemaError, CanopyUnavailableError } from "./errors.ts";
import { type AgentDefinition, parseRenderedAgent } from "./schema.ts";

export interface RefreshSkipped {
	readonly name: string;
	readonly reason: string;
	readonly code: string;
}

export interface RefreshResult {
	readonly clone: CloneResult;
	readonly registered: AgentRow[];
	readonly skipped: RefreshSkipped[];
	readonly removed: string[];
}

export interface RefreshOptions {
	readonly client: CanopyClient;
	readonly agents: AgentsRepo;
	/** Inject the cloner; defaults to the live `cloneOrUpdateCanopyRepo`. */
	readonly clone?: (
		opts: Omit<CloneOptions, "spawn"> & { spawn: CloneOptions["spawn"] },
	) => Promise<CloneResult>;
	readonly cloneOptions: Omit<CloneOptions, "spawn"> & Pick<CloneOptions, "spawn">;
	/**
	 * If true, delete agents that exist in warren's table but are no longer
	 * in the canopy repo. Off by default — see file header.
	 */
	readonly prune?: boolean;
	readonly now?: () => Date;
}

export async function refreshAgentRegistry(opts: RefreshOptions): Promise<RefreshResult> {
	const cloneFn = opts.clone ?? cloneOrUpdateCanopyRepo;
	const clone = await cloneFn(opts.cloneOptions);

	const summaries = await opts.client.listAgents();
	const seen = new Set<string>();
	const registered: AgentRow[] = [];
	const skipped: RefreshSkipped[] = [];

	for (const summary of summaries) {
		seen.add(summary.name);
		const outcome = await registerOne(opts, summary);
		if (outcome.kind === "registered") {
			registered.push(outcome.row);
		} else {
			skipped.push(outcome.skipped);
		}
	}

	const removed: string[] = [];
	if (opts.prune === true) {
		for (const existing of await opts.agents.listAll()) {
			if (!seen.has(existing.name)) {
				await opts.agents.delete(existing.name);
				removed.push(existing.name);
			}
		}
	}

	return { clone, registered, skipped, removed };
}

type RegisterOutcome =
	| { kind: "registered"; row: AgentRow }
	| { kind: "skipped"; skipped: RefreshSkipped };

async function registerOne(opts: RefreshOptions, summary: AgentSummary): Promise<RegisterOutcome> {
	let raw: unknown;
	try {
		raw = await opts.client.renderAgent(summary.name);
	} catch (err) {
		if (err instanceof CanopyUnavailableError) {
			// A render-time canopy error for one prompt (e.g. "Prompt not found"
			// after a race with `cn archive`) is per-prompt, not catastrophic.
			return {
				kind: "skipped",
				skipped: {
					name: summary.name,
					code: err.code,
					reason: err.message,
				},
			};
		}
		throw err;
	}

	let definition: AgentDefinition;
	try {
		definition = parseRenderedAgent(raw, summary.name);
	} catch (err) {
		if (err instanceof AgentSchemaError) {
			return {
				kind: "skipped",
				skipped: { name: summary.name, code: err.code, reason: err.message },
			};
		}
		throw err;
	}

	const row = await opts.agents.upsert({
		name: definition.name,
		renderedJson: definition,
		now: opts.now?.(),
	});
	return { kind: "registered", row };
}
