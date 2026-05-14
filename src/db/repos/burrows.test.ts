import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { NotFoundError } from "../../core/errors.ts";
import { openDatabase, type WarrenDb } from "../client.ts";
import { BurrowsRepo } from "./burrows.ts";

describe("BurrowsRepo", () => {
	let db: WarrenDb;
	let repo: BurrowsRepo;

	beforeEach(async () => {
		db = await openDatabase({ path: ":memory:" });
		repo = new BurrowsRepo(db.drizzle);
	});

	afterEach(async () => {
		await db.close();
	});

	test("create stamps addedAt and stores the worker_id", async () => {
		const row = await repo.create({
			id: "bur_aaaaaaaaaaaa",
			workerId: "alpha",
			now: new Date("2026-05-13T00:00:00.000Z"),
		});
		expect(row.id).toBe("bur_aaaaaaaaaaaa");
		expect(row.workerId).toBe("alpha");
		expect(row.addedAt).toBe("2026-05-13T00:00:00.000Z");
	});

	test("get returns null for an unknown burrow", async () => {
		expect(await repo.get("bur_missing00000")).toBeNull();
	});

	test("require throws NotFoundError for an unknown burrow", async () => {
		expect(repo.require("bur_missing00000")).rejects.toThrow(NotFoundError);
	});

	test("listByWorker filters rows to one worker", async () => {
		await repo.create({
			id: "bur_aaaaaaaaaaaa",
			workerId: "alpha",
			now: new Date("2026-05-13T00:00:00.000Z"),
		});
		await repo.create({
			id: "bur_bbbbbbbbbbbb",
			workerId: "beta",
			now: new Date("2026-05-13T00:00:01.000Z"),
		});
		await repo.create({
			id: "bur_cccccccccccc",
			workerId: "alpha",
			now: new Date("2026-05-13T00:00:02.000Z"),
		});
		const alphas = (await repo.listByWorker("alpha")).map((b) => b.id);
		expect(alphas).toEqual(["bur_aaaaaaaaaaaa", "bur_cccccccccccc"]);
		const betas = (await repo.listByWorker("beta")).map((b) => b.id);
		expect(betas).toEqual(["bur_bbbbbbbbbbbb"]);
	});

	test("listAll orders by addedAt then id", async () => {
		await repo.create({
			id: "bur_bbbbbbbbbbbb",
			workerId: "alpha",
			now: new Date("2026-05-13T00:00:00.000Z"),
		});
		await repo.create({
			id: "bur_aaaaaaaaaaaa",
			workerId: "alpha",
			now: new Date("2026-05-13T00:00:00.000Z"),
		});
		await repo.create({
			id: "bur_cccccccccccc",
			workerId: "beta",
			now: new Date("2026-05-13T00:00:01.000Z"),
		});
		expect((await repo.listAll()).map((b) => b.id)).toEqual([
			"bur_aaaaaaaaaaaa",
			"bur_bbbbbbbbbbbb",
			"bur_cccccccccccc",
		]);
	});

	test("delete removes the row", async () => {
		await repo.create({ id: "bur_aaaaaaaaaaaa", workerId: "alpha" });
		await repo.delete("bur_aaaaaaaaaaaa");
		expect(await repo.get("bur_aaaaaaaaaaaa")).toBeNull();
	});

	test("create with a duplicate id throws (id is the PK; no upsert)", async () => {
		await repo.create({ id: "bur_aaaaaaaaaaaa", workerId: "alpha" });
		expect(repo.create({ id: "bur_aaaaaaaaaaaa", workerId: "beta" })).rejects.toThrow();
	});
});
