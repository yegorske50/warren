/**
 * Dialect-aware test substrate for warren's durable state (R-13, pl-f17e step 6).
 *
 * `withDb()` opens an isolated, freshly-migrated database for a single test
 * and returns a handle whose `close()` (or `Symbol.asyncDispose` for `await
 * using`) tears it back down. Two backends share one entry point:
 *
 *   - **SQLite (default)** — `:memory:` via `openDatabase({ url: ":memory:" })`.
 *     Matches today's `beforeEach(async () => db = await openDatabase(...))`
 *     pattern; the helper just centralizes it so the postgres branch can plug
 *     into the same call shape.
 *   - **Postgres (opt-in)** — `WARREN_TEST_DIALECT=postgres` +
 *     `WARREN_TEST_PG_URL=postgres://...`. Each `withDb()` call creates a
 *     fresh schema (`warren_test_<8hex>`), runs the per-dialect migration
 *     set into that schema (drizzle's `__drizzle_migrations` is also pinned
 *     into the test schema via `migrationsSchema`), and drops it on close.
 *     Schema isolation lets tests run in parallel without truncating each
 *     other; drop-cascade also reclaims the migrations bookkeeping.
 *
 * ## Substrate decision: env-gated WARREN_TEST_PG_URL
 *
 * Three options were on the table:
 *
 *   1. **pglite** (in-process WASM Postgres) — lightweight, no daemon, runs
 *      everywhere. Rejected for V1: adds a new runtime dep, WASM/Bun
 *      compatibility is unproven in this codebase, and pglite is single-
 *      connection so it doesn't exercise the pg.Pool starvation path
 *      acceptance scenario 19 needs to cover. Keep as a future enhancement
 *      if local-dev friction surfaces.
 *   2. **testcontainers** — boots a real Postgres container per scenario.
 *      Rejected at the unit-test layer: Docker daemon dependency, slow
 *      startup, heavier than needed for "does this repo query work on pg".
 *      Reserved for the acceptance harness (warren-480a, step 7) where
 *      end-to-end realism is the point.
 *   3. **env-gated WARREN_TEST_PG_URL** (chosen) — operators (and CI)
 *      expose a real Postgres at a URL; tests opt in via env var. Zero new
 *      runtime deps, exercises the actual `drizzle-orm/node-postgres` path
 *      including pool semantics, and local dev defaults to sqlite so the
 *      no-friction story stays intact. CI runs the matrix by setting both
 *      env vars in a job that has a `services: postgres:` block.
 *
 * Risk #7 in pl-f17e is parked here: "Test infrastructure for the pg path
 * adds CI cost and flakiness." The env-gate keeps the cost gated to CI
 * jobs that explicitly opt in.
 */

import { randomBytes } from "node:crypto";
import { join } from "node:path";
import { migrate as migratePg } from "drizzle-orm/node-postgres/migrator";
import {
	type AnyWarrenDb,
	openDatabase,
	type PostgresWarrenDb,
	type SqliteWarrenDb,
	type WarrenDialect,
} from "./client.ts";

/** Selects the test backend: `sqlite` (default) or `postgres`. */
export const WARREN_TEST_DIALECT_ENV = "WARREN_TEST_DIALECT" as const;
/** Postgres URL the env-gated test substrate connects to. */
export const WARREN_TEST_PG_URL_ENV = "WARREN_TEST_PG_URL" as const;

const DEFAULT_PG_MIGRATIONS_FOLDER = join(import.meta.dir, "migrations", "postgres");

export interface WithDbOptions {
	/**
	 * Override the env-resolved dialect. Use for dialect-specific test
	 * fixtures (e.g. `describe.skipIf(resolveTestDialect() !== "postgres")`
	 * blocks that always want pg regardless of the default). Most tests
	 * should omit this and let the env knob drive the matrix.
	 */
	dialect?: WarrenDialect;
}

export interface TestDbHandle<D extends AnyWarrenDb = AnyWarrenDb> {
	readonly db: D;
	readonly dialect: WarrenDialect;
	/** Postgres-only: the unique schema created for this handle. */
	readonly schemaName?: string;
	/** Drops the test schema (pg) and closes the underlying handle. */
	close(): Promise<void>;
	[Symbol.asyncDispose](): Promise<void>;
}

/**
 * Resolve the effective test dialect. Reads `WARREN_TEST_DIALECT` (case-
 * insensitive; accepts `postgres` or `postgresql`); falls back to `sqlite`.
 * An explicit override wins over the env var.
 */
export function resolveTestDialect(override?: WarrenDialect): WarrenDialect {
	if (override) return override;
	const raw = process.env[WARREN_TEST_DIALECT_ENV];
	if (!raw) return "sqlite";
	const normalized = raw.trim().toLowerCase();
	if (normalized === "postgres" || normalized === "postgresql") return "postgres";
	if (normalized === "sqlite" || normalized === "") return "sqlite";
	throw new Error(
		`${WARREN_TEST_DIALECT_ENV}=${JSON.stringify(raw)} is not a known dialect. ` +
			"Use 'sqlite' (default) or 'postgres'.",
	);
}

/** Resolve `WARREN_TEST_PG_URL` or throw with a copy-paste hint. */
export function requireTestPgUrl(): string {
	const url = process.env[WARREN_TEST_PG_URL_ENV];
	if (!url || url.trim() === "") {
		throw new Error(
			`${WARREN_TEST_PG_URL_ENV} is required when ${WARREN_TEST_DIALECT_ENV}=postgres. ` +
				"Example: WARREN_TEST_PG_URL=postgres://warren:warren@127.0.0.1:5432/warren_test",
		);
	}
	return url;
}

/**
 * Returns true when the postgres path is configured and ready to use.
 * Tests that always need pg should guard their `describe(...)` with
 * `describe.skipIf(!isPostgresTestEnabled())(...)`.
 */
export function isPostgresTestEnabled(): boolean {
	if (resolveTestDialect() !== "postgres") return false;
	const url = process.env[WARREN_TEST_PG_URL_ENV];
	return !!url && url.trim() !== "";
}

export function withDb(options: { dialect: "sqlite" }): Promise<TestDbHandle<SqliteWarrenDb>>;
export function withDb(options: { dialect: "postgres" }): Promise<TestDbHandle<PostgresWarrenDb>>;
export function withDb(options?: WithDbOptions): Promise<TestDbHandle>;
export async function withDb(options: WithDbOptions = {}): Promise<TestDbHandle> {
	const dialect = resolveTestDialect(options.dialect);
	if (dialect === "sqlite") return openSqliteTestDb();
	return openPostgresTestDb();
}

async function openSqliteTestDb(): Promise<TestDbHandle<SqliteWarrenDb>> {
	// `{ path }` selects the sqlite-typed openDatabase overload, so the handle
	// narrows to SqliteWarrenDb without a runtime branch.
	const db = await openDatabase({ path: ":memory:" });
	const close = async (): Promise<void> => {
		await db.close();
	};
	return {
		db,
		dialect: "sqlite",
		close,
		[Symbol.asyncDispose]: close,
	};
}

async function openPostgresTestDb(): Promise<TestDbHandle<PostgresWarrenDb>> {
	const baseUrl = requireTestPgUrl();
	const schemaName = `warren_test_${randomBytes(4).toString("hex")}`;
	const url = appendPgConnectionOption(baseUrl, `search_path=${schemaName}`);

	// `skipMigrations: true` because we have to CREATE SCHEMA first, then run
	// migrations with `migrationsSchema` pinned to the test schema so drizzle's
	// `__drizzle_migrations` lands inside the test schema (and is reaped by
	// DROP SCHEMA CASCADE). The default openDatabase pg path runs migrations
	// against the public schema, which is the right behavior for production
	// but not for test isolation.
	const opened = await openDatabase({ url, skipMigrations: true, pgPoolMax: 2 });
	if (opened.dialect !== "postgres") {
		await opened.close();
		throw new Error(
			`expected postgres dialect from ${WARREN_TEST_PG_URL_ENV}; got ${opened.dialect}`,
		);
	}
	const db = opened;

	try {
		await db.raw.query(`CREATE SCHEMA "${schemaName}"`);
		await migratePg(db.drizzle, {
			migrationsFolder: DEFAULT_PG_MIGRATIONS_FOLDER,
			migrationsSchema: schemaName,
		});
	} catch (err) {
		await dropSchemaSafely(db, schemaName);
		await db.close();
		throw err;
	}

	const close = async (): Promise<void> => {
		try {
			await dropSchemaSafely(db, schemaName);
		} finally {
			await db.close();
		}
	};

	return {
		db,
		dialect: "postgres",
		schemaName,
		close,
		[Symbol.asyncDispose]: close,
	};
}

async function dropSchemaSafely(db: PostgresWarrenDb, schemaName: string): Promise<void> {
	try {
		await db.raw.query(`DROP SCHEMA IF EXISTS "${schemaName}" CASCADE`);
	} catch {
		// best-effort: if the pool is already broken there's nothing to drop.
	}
}

/**
 * Append `options=-c <kv>` to a Postgres connection URL so node-postgres
 * applies the server-side runtime parameter as a connection startup option.
 * Used to pin `search_path` so per-test schemas are auto-selected on every
 * pooled connection.
 */
function appendPgConnectionOption(url: string, kv: string): string {
	const sep = url.includes("?") ? "&" : "?";
	const value = encodeURIComponent(`-c ${kv}`);
	return `${url}${sep}options=${value}`;
}
