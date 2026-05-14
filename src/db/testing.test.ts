import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
	isPostgresTestEnabled,
	requireTestPgUrl,
	resolveTestDialect,
	WARREN_TEST_DIALECT_ENV,
	WARREN_TEST_PG_URL_ENV,
	withDb,
} from "./testing.ts";

describe("resolveTestDialect", () => {
	let originalDialect: string | undefined;

	beforeEach(() => {
		originalDialect = process.env[WARREN_TEST_DIALECT_ENV];
		delete process.env[WARREN_TEST_DIALECT_ENV];
	});

	afterEach(() => {
		if (originalDialect === undefined) delete process.env[WARREN_TEST_DIALECT_ENV];
		else process.env[WARREN_TEST_DIALECT_ENV] = originalDialect;
	});

	test("defaults to sqlite when env is unset", () => {
		expect(resolveTestDialect()).toBe("sqlite");
	});

	test("respects explicit override over env", () => {
		process.env[WARREN_TEST_DIALECT_ENV] = "postgres";
		expect(resolveTestDialect("sqlite")).toBe("sqlite");
	});

	test("accepts postgres/postgresql/sqlite case-insensitively", () => {
		process.env[WARREN_TEST_DIALECT_ENV] = "POSTGRES";
		expect(resolveTestDialect()).toBe("postgres");
		process.env[WARREN_TEST_DIALECT_ENV] = "PostgreSQL";
		expect(resolveTestDialect()).toBe("postgres");
		process.env[WARREN_TEST_DIALECT_ENV] = "SQLite";
		expect(resolveTestDialect()).toBe("sqlite");
	});

	test("throws on an unknown dialect", () => {
		process.env[WARREN_TEST_DIALECT_ENV] = "duckdb";
		expect(() => resolveTestDialect()).toThrow(/not a known dialect/);
	});
});

describe("requireTestPgUrl", () => {
	let originalUrl: string | undefined;

	beforeEach(() => {
		originalUrl = process.env[WARREN_TEST_PG_URL_ENV];
		delete process.env[WARREN_TEST_PG_URL_ENV];
	});

	afterEach(() => {
		if (originalUrl === undefined) delete process.env[WARREN_TEST_PG_URL_ENV];
		else process.env[WARREN_TEST_PG_URL_ENV] = originalUrl;
	});

	test("throws with a copy-paste hint when the env is unset", () => {
		expect(() => requireTestPgUrl()).toThrow(/WARREN_TEST_PG_URL is required/);
	});

	test("returns the trimmed value when set", () => {
		process.env[WARREN_TEST_PG_URL_ENV] = "postgres://u:p@h:5432/db";
		expect(requireTestPgUrl()).toBe("postgres://u:p@h:5432/db");
	});
});

describe("isPostgresTestEnabled", () => {
	let originalDialect: string | undefined;
	let originalUrl: string | undefined;

	beforeEach(() => {
		originalDialect = process.env[WARREN_TEST_DIALECT_ENV];
		originalUrl = process.env[WARREN_TEST_PG_URL_ENV];
		delete process.env[WARREN_TEST_DIALECT_ENV];
		delete process.env[WARREN_TEST_PG_URL_ENV];
	});

	afterEach(() => {
		if (originalDialect === undefined) delete process.env[WARREN_TEST_DIALECT_ENV];
		else process.env[WARREN_TEST_DIALECT_ENV] = originalDialect;
		if (originalUrl === undefined) delete process.env[WARREN_TEST_PG_URL_ENV];
		else process.env[WARREN_TEST_PG_URL_ENV] = originalUrl;
	});

	test("false when dialect is sqlite", () => {
		process.env[WARREN_TEST_PG_URL_ENV] = "postgres://u:p@h/db";
		expect(isPostgresTestEnabled()).toBe(false);
	});

	test("false when dialect is postgres but url is unset", () => {
		process.env[WARREN_TEST_DIALECT_ENV] = "postgres";
		expect(isPostgresTestEnabled()).toBe(false);
	});

	test("true when both are set", () => {
		process.env[WARREN_TEST_DIALECT_ENV] = "postgres";
		process.env[WARREN_TEST_PG_URL_ENV] = "postgres://u:p@h/db";
		expect(isPostgresTestEnabled()).toBe(true);
	});
});

describe("withDb (sqlite)", () => {
	test("returns a migrated sqlite handle with the expected dialect", async () => {
		const handle = await withDb({ dialect: "sqlite" });
		try {
			expect(handle.dialect).toBe("sqlite");
			expect(handle.schemaName).toBeUndefined();
			if (handle.db.dialect !== "sqlite") throw new Error("expected sqlite db");
			const names = handle.db.raw
				.query<{ name: string }, []>(
					"SELECT name FROM sqlite_master WHERE type='table' ORDER BY name",
				)
				.all()
				.map((r) => r.name);
			for (const expected of ["agents", "projects", "runs", "events", "triggers"]) {
				expect(names).toContain(expected);
			}
		} finally {
			await handle.close();
		}
	});

	test("each call returns an isolated db", async () => {
		const a = await withDb({ dialect: "sqlite" });
		const b = await withDb({ dialect: "sqlite" });
		try {
			if (a.db.dialect !== "sqlite" || b.db.dialect !== "sqlite") {
				throw new Error("expected sqlite");
			}
			a.db.raw.exec(
				"INSERT INTO agents (name, rendered_json, registered_at, last_refreshed) VALUES ('a', '{}', 't', 't')",
			);
			const countB = b.db.raw.query<{ c: number }, []>("SELECT COUNT(*) AS c FROM agents").get();
			expect(countB?.c).toBe(0);
		} finally {
			await a.close();
			await b.close();
		}
	});

	test("await using disposes the handle", async () => {
		let captured: { dialect: string } | null = null;
		{
			await using handle = await withDb({ dialect: "sqlite" });
			captured = { dialect: handle.dialect };
		}
		expect(captured).toEqual({ dialect: "sqlite" });
	});
});

describe.skipIf(!isPostgresTestEnabled())("withDb (postgres)", () => {
	test("returns a migrated, schema-isolated pg handle", async () => {
		const handle = await withDb({ dialect: "postgres" });
		try {
			expect(handle.dialect).toBe("postgres");
			expect(handle.schemaName).toMatch(/^warren_test_[0-9a-f]{8}$/);
			if (handle.db.dialect !== "postgres") throw new Error("expected postgres db");
			const { rows } = await handle.db.raw.query<{ table_name: string }>(
				"SELECT table_name FROM information_schema.tables WHERE table_schema = $1 ORDER BY table_name",
				[handle.schemaName],
			);
			const names = rows.map((r) => r.table_name);
			for (const expected of ["agents", "projects", "runs", "events", "triggers"]) {
				expect(names).toContain(expected);
			}
		} finally {
			await handle.close();
		}
	});

	test("close drops the test schema", async () => {
		const handle = await withDb({ dialect: "postgres" });
		const schemaName = handle.schemaName;
		await handle.close();

		// Open a fresh handle just to get a pool we can probe with.
		const probe = await withDb({ dialect: "postgres" });
		try {
			if (probe.db.dialect !== "postgres") throw new Error("expected postgres db");
			const { rows } = await probe.db.raw.query<{ count: string }>(
				"SELECT COUNT(*)::text AS count FROM information_schema.schemata WHERE schema_name = $1",
				[schemaName],
			);
			expect(rows[0]?.count).toBe("0");
		} finally {
			await probe.close();
		}
	});

	test("parallel handles are isolated", async () => {
		const [a, b] = await Promise.all([
			withDb({ dialect: "postgres" }),
			withDb({ dialect: "postgres" }),
		]);
		try {
			expect(a.schemaName).not.toBe(b.schemaName);
			if (a.db.dialect !== "postgres" || b.db.dialect !== "postgres") {
				throw new Error("expected postgres");
			}
			await a.db.raw.query(
				"INSERT INTO agents (name, rendered_json, registered_at, last_refreshed) VALUES ('a', '{}'::jsonb, 't', 't')",
			);
			const { rows } = await b.db.raw.query<{ count: string }>(
				"SELECT COUNT(*)::text AS count FROM agents",
			);
			expect(rows[0]?.count).toBe("0");
		} finally {
			await a.close();
			await b.close();
		}
	});
});
