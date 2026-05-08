import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDatabase } from "./client.ts";

describe("openDatabase", () => {
	test("runs migrations against a fresh in-memory db", async () => {
		const db = await openDatabase({ path: ":memory:" });
		try {
			const tables = db.raw
				.query<{ name: string }, []>(
					"SELECT name FROM sqlite_master WHERE type='table' ORDER BY name",
				)
				.all();
			const names = tables.map((t) => t.name);
			for (const expected of ["agents", "projects", "runs", "events"]) {
				expect(names).toContain(expected);
			}
		} finally {
			db.close();
		}
	});

	test("enables WAL on file-backed databases and creates parent dirs", async () => {
		const tmp = mkdtempSync(join(tmpdir(), "warren-db-"));
		const dbPath = join(tmp, "nested", "warren.db");
		const db = await openDatabase({ path: dbPath });
		try {
			const mode = db.raw.query<{ journal_mode: string }, []>("PRAGMA journal_mode").get();
			expect(mode?.journal_mode).toBe("wal");
			const fk = db.raw.query<{ foreign_keys: number }, []>("PRAGMA foreign_keys").get();
			expect(fk?.foreign_keys).toBe(1);
		} finally {
			db.close();
			rmSync(tmp, { recursive: true, force: true });
		}
	});

	test("re-opening an existing db is idempotent for migrations", async () => {
		const tmp = mkdtempSync(join(tmpdir(), "warren-db-"));
		const dbPath = join(tmp, "warren.db");
		const a = await openDatabase({ path: dbPath });
		a.close();
		const b = await openDatabase({ path: dbPath });
		try {
			const tables = b.raw
				.query<{ name: string }, []>(
					"SELECT name FROM sqlite_master WHERE type='table' AND name='runs'",
				)
				.all();
			expect(tables).toHaveLength(1);
		} finally {
			b.close();
			rmSync(tmp, { recursive: true, force: true });
		}
	});

	test("created indexes match the schema", async () => {
		const db = await openDatabase({ path: ":memory:" });
		try {
			const idx = db.raw
				.query<{ name: string }, []>(
					"SELECT name FROM sqlite_master WHERE type='index' AND name NOT LIKE 'sqlite_%' ORDER BY name",
				)
				.all();
			const names = idx.map((i) => i.name);
			for (const expected of [
				"events_run_seq_idx",
				"events_run_ts_idx",
				"projects_git_url_idx",
				"runs_agent_started_idx",
				"runs_project_started_idx",
				"runs_state_idx",
			]) {
				expect(names).toContain(expected);
			}
		} finally {
			db.close();
		}
	});
});
