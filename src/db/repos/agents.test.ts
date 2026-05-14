import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { NotFoundError } from "../../core/errors.ts";
import { openDatabase, type WarrenDb } from "../client.ts";
import { AgentsRepo } from "./agents.ts";

describe("AgentsRepo", () => {
	let db: WarrenDb;
	let repo: AgentsRepo;

	beforeEach(async () => {
		db = await openDatabase({ path: ":memory:" });
		repo = new AgentsRepo(db.drizzle);
	});

	afterEach(async () => {
		await db.close();
	});

	test("upsert inserts a new row with both timestamps equal", async () => {
		const now = new Date("2026-05-08T12:00:00.000Z");
		const row = await repo.upsert({
			name: "refactor-bot",
			renderedJson: { sections: { system: "..." } },
			now,
		});
		expect(row.name).toBe("refactor-bot");
		expect(row.registeredAt).toBe(now.toISOString());
		expect(row.lastRefreshed).toBe(now.toISOString());
		expect(row.renderedJson).toEqual({ sections: { system: "..." } });
	});

	test("upsert on an existing row preserves registeredAt and bumps lastRefreshed", async () => {
		const t0 = new Date("2026-05-08T12:00:00.000Z");
		const t1 = new Date("2026-05-09T12:00:00.000Z");
		await repo.upsert({ name: "refactor-bot", renderedJson: { v: 1 }, now: t0 });
		const row = await repo.upsert({ name: "refactor-bot", renderedJson: { v: 2 }, now: t1 });
		expect(row.registeredAt).toBe(t0.toISOString());
		expect(row.lastRefreshed).toBe(t1.toISOString());
		expect(row.renderedJson).toEqual({ v: 2 });
	});

	test("get returns null for unknown names; require throws NotFoundError", async () => {
		expect(await repo.get("missing")).toBeNull();
		expect(repo.require("missing")).rejects.toThrow(NotFoundError);
	});

	test("listAll returns rows alphabetically by name", async () => {
		await repo.upsert({ name: "zebra", renderedJson: {} });
		await repo.upsert({ name: "alpha", renderedJson: {} });
		await repo.upsert({ name: "mango", renderedJson: {} });
		expect((await repo.listAll()).map((r) => r.name)).toEqual(["alpha", "mango", "zebra"]);
	});

	test("delete removes the row", async () => {
		await repo.upsert({ name: "refactor-bot", renderedJson: {} });
		await repo.delete("refactor-bot");
		expect(await repo.get("refactor-bot")).toBeNull();
	});
});
