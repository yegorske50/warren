/**
 * Migration parity smoke test (R-13, pl-f17e step 4, acceptance #7).
 *
 * Validates that both dialect migration folders exist, hold well-formed
 * drizzle journals, and that every journaled tag points at a real `.sql`
 * file. This is the baseline for the future CI parity gate (step 9 docs)
 * which will additionally enforce that every commit adding a file to one
 * folder adds a sibling to the other.
 *
 * We deliberately do NOT assert tag-for-tag parity between the two
 * dialects today: the SQLite history walks 0000_init … 0008 (including
 * the 12-step ALTER pattern in 0003 that has no pg analogue, mx-9c90e8),
 * while the Postgres set is regenerated from scratch as a single
 * 0000_init that builds the final schema. From the next schema change
 * forward, BOTH dialects pick up a matching tag — that's what the parity
 * gate enforces.
 *
 * The Postgres migrator itself is not exercised here (no live pg in unit
 * tests; that lands in step 6 warren-c823 + step 7 warren-480a). Schema
 * shape parity between the two dialect modules is already covered by
 * `src/db/schema/drift.test.ts`.
 */

import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

const MIGRATIONS_ROOT = join(import.meta.dir);
const SQLITE_FOLDER = MIGRATIONS_ROOT;
const POSTGRES_FOLDER = join(MIGRATIONS_ROOT, "postgres");

interface JournalEntry {
	idx: number;
	version: string;
	when: number;
	tag: string;
	breakpoints: boolean;
}

interface Journal {
	version: string;
	dialect: string;
	entries: JournalEntry[];
}

function readJournal(folder: string): Journal {
	const path = join(folder, "meta", "_journal.json");
	expect(existsSync(path), `${path} missing`).toBe(true);
	return JSON.parse(readFileSync(path, "utf8")) as Journal;
}

describe("migration journals", () => {
	test("sqlite journal is well-formed", () => {
		const j = readJournal(SQLITE_FOLDER);
		expect(j.dialect).toBe("sqlite");
		expect(j.entries.length).toBeGreaterThan(0);
		for (const entry of j.entries) {
			expect(existsSync(join(SQLITE_FOLDER, `${entry.tag}.sql`))).toBe(true);
			expect(
				existsSync(
					join(SQLITE_FOLDER, "meta", `${String(entry.idx).padStart(4, "0")}_snapshot.json`),
				),
			).toBe(true);
		}
	});

	test("postgres journal is well-formed", () => {
		const j = readJournal(POSTGRES_FOLDER);
		expect(j.dialect).toBe("postgresql");
		expect(j.entries.length).toBeGreaterThan(0);
		for (const entry of j.entries) {
			expect(existsSync(join(POSTGRES_FOLDER, `${entry.tag}.sql`))).toBe(true);
			expect(
				existsSync(
					join(POSTGRES_FOLDER, "meta", `${String(entry.idx).padStart(4, "0")}_snapshot.json`),
				),
			).toBe(true);
		}
	});

	test("idx values are contiguous and zero-based in both journals", () => {
		for (const folder of [SQLITE_FOLDER, POSTGRES_FOLDER]) {
			const j = readJournal(folder);
			for (let i = 0; i < j.entries.length; i++) {
				expect(j.entries[i]?.idx).toBe(i);
			}
		}
	});
});
