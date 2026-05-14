/**
 * `withCliDb` — open the warren DB, build a Repos handle, run the body,
 * and close the DB on exit (success or failure).
 *
 * `register-agent`, `add-project`, and `run` need DB access, but `serve`
 * owns its own DB lifecycle inside `bootServer`, and `doctor` doesn't
 * touch SQLite at all. So this lifecycle helper is opt-in per command
 * rather than baked into `CliContext`.
 *
 * The DB path resolves the same way `bootServer` resolves it (see
 * `server/config.ts`): explicit `WARREN_DB_PATH`, else `<DATA_DIR>/warren.db`,
 * else `/data/warren.db`. The CLI is meant to run alongside `warren serve`
 * inside the same container, so the default lands on the supervised data
 * volume without extra config.
 */

import { join } from "node:path";
import { openDatabase, type WarrenDb } from "../db/client.ts";
import { createRepos, type Repos } from "../db/repos/index.ts";
import type { EnvLike } from "./output.ts";

export const DEFAULT_DATA_DIR = "/data";

export interface ResolvedDbPath {
	readonly path: string;
}

export function resolveDbPath(env: EnvLike): ResolvedDbPath {
	const explicit = env.WARREN_DB_PATH;
	if (explicit !== undefined && explicit !== "") return { path: explicit };
	const dataDir = env.WARREN_DATA_DIR ?? DEFAULT_DATA_DIR;
	return { path: join(dataDir, "warren.db") };
}

export interface WithCliDbInput {
	readonly env: EnvLike;
	/** Override the DB path (tests pass `:memory:`). */
	readonly dbPath?: string;
}

export async function withCliDb<T>(
	input: WithCliDbInput,
	fn: (handle: { db: WarrenDb; repos: Repos }) => Promise<T>,
): Promise<T> {
	const path = input.dbPath ?? resolveDbPath(input.env).path;
	const db = await openDatabase({ path });
	const repos = createRepos(db);
	try {
		return await fn({ db, repos });
	} finally {
		try {
			await db.close();
		} catch {
			// Closing twice during a panicked teardown is fine.
		}
	}
}
