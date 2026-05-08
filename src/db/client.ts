/**
 * Drizzle + bun:sqlite database client.
 *
 * `openDatabase` opens (or creates) the SQLite file, enables WAL mode, runs
 * any pending migrations, and returns a typed drizzle handle plus the raw
 * connection. Callers close via `db.close()` to release the file.
 *
 * WAL is enabled at startup (SPEC §6 "DB: bun:sqlite (WAL mode)") so concurrent
 * readers don't block the single writer; the pragmas are idempotent and cheap
 * to set on every open. Tests pass `path: ":memory:"` for an ephemeral DB —
 * migrations still run so the schema matches production.
 */

import { Database } from "bun:sqlite";
import { mkdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import { drizzle } from "drizzle-orm/bun-sqlite";
import { migrate } from "drizzle-orm/bun-sqlite/migrator";
import * as schema from "./schema.ts";

const DEFAULT_MIGRATIONS_FOLDER = join(import.meta.dir, "migrations");

export type DrizzleDb = ReturnType<typeof drizzle<typeof schema>>;

export interface WarrenDb {
	drizzle: DrizzleDb;
	raw: Database;
	close(): void;
}

export interface OpenDatabaseOptions {
	path: string;
	migrationsFolder?: string;
	skipMigrations?: boolean;
}

export async function openDatabase(options: OpenDatabaseOptions): Promise<WarrenDb> {
	if (options.path !== ":memory:") {
		await mkdir(dirname(options.path), { recursive: true });
	}

	const raw = new Database(options.path, { create: true });
	configurePragmas(raw, options.path === ":memory:");

	const db = drizzle(raw, { schema });

	if (!options.skipMigrations) {
		migrate(db, {
			migrationsFolder: options.migrationsFolder ?? DEFAULT_MIGRATIONS_FOLDER,
		});
	}

	return {
		drizzle: db,
		raw,
		close: () => raw.close(),
	};
}

function configurePragmas(raw: Database, inMemory: boolean): void {
	if (!inMemory) {
		raw.exec("PRAGMA journal_mode = WAL");
		raw.exec("PRAGMA synchronous = NORMAL");
	}
	raw.exec("PRAGMA foreign_keys = ON");
	raw.exec("PRAGMA busy_timeout = 5000");
}

export { schema };
