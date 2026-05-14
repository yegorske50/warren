import { describe, expect, test } from "bun:test";
import { NotFoundError } from "../../core/errors.ts";
import { isPostgresTestEnabled, withDb } from "../testing.ts";
import { BurrowsRepo } from "./burrows.ts";
import { DrizzleAdapter } from "./drizzle-adapter.ts";

function suite(dialect: "sqlite" | "postgres"): void {
	describe(`BurrowsRepo (${dialect})`, () => {
		const open = async () => {
			const handle = await withDb({ dialect });
			const repo = new BurrowsRepo(DrizzleAdapter.for(handle.db));
			return { handle, repo };
		};

		test("create stamps addedAt and stores the worker_id", async () => {
			const { handle, repo } = await open();
			try {
				const row = await repo.create({
					id: "bur_aaaaaaaaaaaa",
					workerId: "alpha",
					now: new Date("2026-05-13T00:00:00.000Z"),
				});
				expect(row.id).toBe("bur_aaaaaaaaaaaa");
				expect(row.workerId).toBe("alpha");
				expect(row.addedAt).toBe("2026-05-13T00:00:00.000Z");
			} finally {
				await handle.close();
			}
		});

		test("get returns null for an unknown burrow", async () => {
			const { handle, repo } = await open();
			try {
				expect(await repo.get("bur_missing00000")).toBeNull();
			} finally {
				await handle.close();
			}
		});

		test("require throws NotFoundError for an unknown burrow", async () => {
			const { handle, repo } = await open();
			try {
				expect(repo.require("bur_missing00000")).rejects.toThrow(NotFoundError);
			} finally {
				await handle.close();
			}
		});

		test("listByWorker filters rows to one worker", async () => {
			const { handle, repo } = await open();
			try {
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
			} finally {
				await handle.close();
			}
		});

		test("listAll orders by addedAt then id", async () => {
			const { handle, repo } = await open();
			try {
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
			} finally {
				await handle.close();
			}
		});

		test("delete removes the row", async () => {
			const { handle, repo } = await open();
			try {
				await repo.create({ id: "bur_aaaaaaaaaaaa", workerId: "alpha" });
				await repo.delete("bur_aaaaaaaaaaaa");
				expect(await repo.get("bur_aaaaaaaaaaaa")).toBeNull();
			} finally {
				await handle.close();
			}
		});

		test("create with a duplicate id throws (id is the PK; no upsert)", async () => {
			const { handle, repo } = await open();
			try {
				await repo.create({ id: "bur_aaaaaaaaaaaa", workerId: "alpha" });
				expect(repo.create({ id: "bur_aaaaaaaaaaaa", workerId: "beta" })).rejects.toThrow();
			} finally {
				await handle.close();
			}
		});
	});
}

suite("sqlite");
if (isPostgresTestEnabled()) {
	suite("postgres");
}
