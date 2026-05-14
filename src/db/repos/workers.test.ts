import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { NotFoundError } from "../../core/errors.ts";
import { openDatabase, type WarrenDb } from "../client.ts";
import { WorkersRepo } from "./workers.ts";

describe("WorkersRepo", () => {
	let db: WarrenDb;
	let repo: WorkersRepo;

	beforeEach(async () => {
		db = await openDatabase({ path: ":memory:" });
		repo = new WorkersRepo(db.drizzle);
	});

	afterEach(async () => {
		await db.close();
	});

	test("upsert inserts a fresh row with default state=healthy", async () => {
		const row = await repo.upsert({
			name: "alpha",
			url: "unix:///var/run/burrow.sock",
			now: new Date("2026-05-13T00:00:00.000Z"),
		});
		expect(row.name).toBe("alpha");
		expect(row.url).toBe("unix:///var/run/burrow.sock");
		expect(row.state).toBe("healthy");
		expect(row.addedAt).toBe("2026-05-13T00:00:00.000Z");
	});

	test("upsert honors an explicit initial state", async () => {
		const row = await repo.upsert({
			name: "alpha",
			url: "http://worker-a:6789",
			state: "draining",
		});
		expect(row.state).toBe("draining");
	});

	test("upsert preserves addedAt across re-registration and updates url", async () => {
		const initial = await repo.upsert({
			name: "alpha",
			url: "http://worker-a:6789",
			now: new Date("2026-05-13T00:00:00.000Z"),
		});
		const updated = await repo.upsert({
			name: "alpha",
			url: "http://worker-a:7000",
			now: new Date("2026-05-14T00:00:00.000Z"),
		});
		expect(updated.url).toBe("http://worker-a:7000");
		expect(updated.addedAt).toBe(initial.addedAt);
	});

	test("upsert without state preserves an existing non-healthy state", async () => {
		await repo.upsert({ name: "alpha", url: "http://a:1" });
		await repo.setState("alpha", "unreachable");
		const reloaded = await repo.upsert({ name: "alpha", url: "http://a:2" });
		expect(reloaded.state).toBe("unreachable");
		expect(reloaded.url).toBe("http://a:2");
	});

	test("upsert with state overrides an existing row's state", async () => {
		await repo.upsert({ name: "alpha", url: "http://a:1" });
		const drained = await repo.upsert({ name: "alpha", url: "http://a:1", state: "draining" });
		expect(drained.state).toBe("draining");
	});

	test("setState flips the state machine", async () => {
		await repo.upsert({ name: "alpha", url: "http://a:1" });
		expect((await repo.setState("alpha", "draining")).state).toBe("draining");
		expect((await repo.setState("alpha", "unreachable")).state).toBe("unreachable");
		expect((await repo.setState("alpha", "healthy")).state).toBe("healthy");
	});

	test("require throws NotFoundError for an unknown worker", async () => {
		expect(repo.require("missing")).rejects.toThrow(NotFoundError);
	});

	test("listAll returns workers in alphabetical name order", async () => {
		await repo.upsert({ name: "gamma", url: "http://g:1" });
		await repo.upsert({ name: "alpha", url: "http://a:1" });
		await repo.upsert({ name: "beta", url: "http://b:1" });
		expect((await repo.listAll()).map((w) => w.name)).toEqual(["alpha", "beta", "gamma"]);
	});

	test("listAll on an empty table returns []", async () => {
		expect(await repo.listAll()).toEqual([]);
	});

	test("delete removes the row", async () => {
		await repo.upsert({ name: "alpha", url: "http://a:1" });
		await repo.delete("alpha");
		expect(await repo.get("alpha")).toBeNull();
	});

	test("name is the primary key (re-insert of same name does not duplicate)", async () => {
		await repo.upsert({ name: "alpha", url: "http://a:1" });
		await repo.upsert({ name: "alpha", url: "http://a:2" });
		expect(await repo.listAll()).toHaveLength(1);
	});
});
