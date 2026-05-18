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

import { mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { AgentsRepo } from "../db/repos/agents.ts";
import type { AgentRow } from "../db/schema.ts";
import { makeProjectAgentSource, stampAgentSource } from "./builtins/index.ts";
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
	const rendered = await renderAndParse(opts.client, summary);
	if (rendered.kind === "skipped") return rendered;
	const row = await opts.agents.upsert({
		name: rendered.definition.name,
		renderedJson: rendered.definition,
		now: opts.now?.(),
	});
	return { kind: "registered", row };
}

export interface RefreshProjectOptions {
	readonly client: CanopyClient;
	readonly agents: AgentsRepo;
	/** Project whose `.canopy/` is being scanned. Stamped onto each row's source. */
	readonly projectId: string;
	/**
	 * Project working tree. When set, each registered agent's rendered JSON
	 * is mirrored to `<projectPath>/.canopy/.rendered/<name>.json` (warren-44e3
	 * follow-up to R-03 / pl-fef5) so `cn render` and other non-warren
	 * consumers can see what a project-tier agent resolves to without going
	 * through the agents-table. Omit to skip the on-disk cache (unit tests).
	 */
	readonly projectPath?: string;
	/**
	 * Override the on-disk cache writer. Defaults to `defaultRenderedCacheWriter`,
	 * which writes JSON via `node:fs/promises`. Only consulted when
	 * `projectPath` is set.
	 */
	readonly cacheWriter?: RenderedCacheWriter;
	readonly now?: () => Date;
}

export interface RefreshProjectResult {
	readonly projectId: string;
	readonly registered: AgentRow[];
	readonly skipped: RefreshSkipped[];
	readonly removed: string[];
}

/** Path of the on-disk rendered cache inside a project working tree. */
export const RENDERED_CACHE_SUBPATH = join(".canopy", ".rendered");

/**
 * Subset of agent-name characters safe to use as a filesystem path
 * component for the rendered cache. Canopy itself constrains prompt names
 * to roughly this shape, but the registry boundary re-validates so a
 * malformed name can never escape `<projectPath>/.canopy/.rendered/`.
 */
const SAFE_AGENT_NAME_RE = /^[a-zA-Z0-9][a-zA-Z0-9._-]*$/;

function isSafeAgentName(name: string): boolean {
	return SAFE_AGENT_NAME_RE.test(name);
}

/**
 * Filesystem-side companion to the agents-table cache. Implementations
 * write a JSON document per project agent and prune entries when a
 * project-scoped row is removed. The writer is invoked once per
 * `refreshProjectAgents` call when `projectPath` is set:
 *   - `init` is called once before iterating prompts (seeds the
 *     `.gitignore` marker so the cache stays out of project commits).
 *   - `write` is called per successfully-registered agent, in upsert order.
 *   - `prune` is called per agent removed from the project tier.
 */
export interface RenderedCacheWriter {
	init(projectPath: string): Promise<void>;
	write(projectPath: string, name: string, definition: AgentDefinition): Promise<void>;
	prune(projectPath: string, name: string): Promise<void>;
}

/**
 * Default writer: `<projectPath>/.canopy/.rendered/<name>.json`, with a
 * self-ignoring `.gitignore` (`*\n`) seeded at init time. The directory
 * is created if missing. Unsafe agent names are skipped silently — the
 * agents-table row is still the authoritative cache.
 */
export const defaultRenderedCacheWriter: RenderedCacheWriter = {
	async init(projectPath) {
		const dir = join(projectPath, RENDERED_CACHE_SUBPATH);
		await mkdir(dir, { recursive: true });
		await writeFile(join(dir, ".gitignore"), "*\n");
	},
	async write(projectPath, name, definition) {
		if (!isSafeAgentName(name)) return;
		const dir = join(projectPath, RENDERED_CACHE_SUBPATH);
		await mkdir(dir, { recursive: true });
		await writeFile(join(dir, `${name}.json`), `${JSON.stringify(definition, null, 2)}\n`);
	},
	async prune(projectPath, name) {
		if (!isSafeAgentName(name)) return;
		await rm(join(projectPath, RENDERED_CACHE_SUBPATH, `${name}.json`), { force: true });
	},
};

/**
 * Project-tier counterpart to `refreshAgentRegistry`. Scans the project's
 * `.canopy/` (via a `CanopyClient.forProjectPath(...)` the caller wires up),
 * renders each agent, stamps `frontmatter.source = "project:<projectId>"`,
 * and upserts at the project scope so global rows of the same name are
 * untouched.
 *
 * Per-agent failures are collected into `skipped` rather than thrown — one
 * malformed `.canopy/` prompt must not take down the whole project refresh
 * (and step 6's all-projects loop relies on this).
 *
 * Transport-level failures (cn binary missing, `.canopy/` unreadable) abort
 * the whole refresh; the caller (`POST /agents/refresh`'s all-projects loop)
 * is responsible for catching them so one bad project doesn't poison the
 * batch.
 *
 * Pruning is always-on for the project tier: the project's `.canopy/` is
 * the authoritative source for that tier, so any project-scoped row whose
 * name disappears from the listing is removed. The library refresh defaults
 * prune=off because a missed git fetch could nuke the registry; the project
 * tier has no equivalent race.
 */
export async function refreshProjectAgents(
	opts: RefreshProjectOptions,
): Promise<RefreshProjectResult> {
	const summaries = await opts.client.listAgents();
	const cacheWriter =
		opts.projectPath !== undefined ? (opts.cacheWriter ?? defaultRenderedCacheWriter) : null;
	if (cacheWriter !== null && opts.projectPath !== undefined) {
		await cacheWriter.init(opts.projectPath);
	}

	const seen = new Set<string>();
	const registered: AgentRow[] = [];
	const skipped: RefreshSkipped[] = [];

	for (const summary of summaries) {
		seen.add(summary.name);
		const outcome = await registerOneProject(opts, summary, cacheWriter);
		if (outcome.kind === "registered") {
			registered.push(outcome.row);
		} else {
			skipped.push(outcome.skipped);
		}
	}

	const removed: string[] = [];
	for (const existing of await opts.agents.listForProject(opts.projectId)) {
		if (!seen.has(existing.name)) {
			await opts.agents.delete(existing.name, { projectId: opts.projectId });
			removed.push(existing.name);
			if (cacheWriter !== null && opts.projectPath !== undefined) {
				await cacheWriter.prune(opts.projectPath, existing.name);
			}
		}
	}

	return { projectId: opts.projectId, registered, skipped, removed };
}

async function registerOneProject(
	opts: RefreshProjectOptions,
	summary: AgentSummary,
	cacheWriter: RenderedCacheWriter | null,
): Promise<RegisterOutcome> {
	const rendered = await renderAndParse(opts.client, summary);
	if (rendered.kind === "skipped") return rendered;
	const stamped = stampAgentSource(rendered.definition, makeProjectAgentSource(opts.projectId));
	const row = await opts.agents.upsert({
		name: stamped.name,
		projectId: opts.projectId,
		renderedJson: stamped,
		now: opts.now?.(),
	});
	if (cacheWriter !== null && opts.projectPath !== undefined) {
		await cacheWriter.write(opts.projectPath, stamped.name, stamped);
	}
	return { kind: "registered", row };
}

type RenderedOutcome =
	| { kind: "rendered"; definition: AgentDefinition }
	| { kind: "skipped"; skipped: RefreshSkipped };

async function renderAndParse(
	client: CanopyClient,
	summary: AgentSummary,
): Promise<RenderedOutcome> {
	let raw: unknown;
	try {
		raw = await client.renderAgent(summary.name);
	} catch (err) {
		if (err instanceof CanopyUnavailableError) {
			// A render-time canopy error for one prompt (e.g. "Prompt not found"
			// after a race with `cn archive`) is per-prompt, not catastrophic.
			return {
				kind: "skipped",
				skipped: { name: summary.name, code: err.code, reason: err.message },
			};
		}
		throw err;
	}
	try {
		return { kind: "rendered", definition: parseRenderedAgent(raw, summary.name) };
	} catch (err) {
		if (err instanceof AgentSchemaError) {
			return {
				kind: "skipped",
				skipped: { name: summary.name, code: err.code, reason: err.message },
			};
		}
		throw err;
	}
}
