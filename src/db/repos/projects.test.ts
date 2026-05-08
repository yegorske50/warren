import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { NotFoundError } from "../../core/errors.ts";
import { isId } from "../../core/ids.ts";
import { openDatabase, type WarrenDb } from "../client.ts";
import { ProjectsRepo } from "./projects.ts";

describe("ProjectsRepo", () => {
	let db: WarrenDb;
	let repo: ProjectsRepo;

	beforeEach(async () => {
		db = await openDatabase({ path: ":memory:" });
		repo = new ProjectsRepo(db.drizzle);
	});

	afterEach(() => {
		db.close();
	});

	test("create assigns a prj_ id and stamps addedAt", () => {
		const now = new Date("2026-05-08T12:00:00.000Z");
		const row = repo.create({
			gitUrl: "https://github.com/jayminwest/warren.git",
			localPath: "/data/projects/jayminwest/warren",
			defaultBranch: "main",
			now,
		});
		expect(isId("project", row.id)).toBe(true);
		expect(row.addedAt).toBe(now.toISOString());
	});

	test("create accepts a caller-supplied id", () => {
		const row = repo.create({
			id: "prj_fixedfixed00",
			gitUrl: "https://github.com/x/y.git",
			localPath: "/data/projects/x/y",
			defaultBranch: "main",
		});
		expect(row.id).toBe("prj_fixedfixed00");
	});

	test("require throws NotFoundError for unknown id", () => {
		expect(() => repo.require("prj_doesnotexist")).toThrow(NotFoundError);
	});

	test("findByGitUrl returns a matching row or null", () => {
		repo.create({
			gitUrl: "https://github.com/x/y.git",
			localPath: "/data/projects/x/y",
			defaultBranch: "main",
		});
		expect(repo.findByGitUrl("https://github.com/x/y.git")?.gitUrl).toBe(
			"https://github.com/x/y.git",
		);
		expect(repo.findByGitUrl("https://github.com/no/match.git")).toBeNull();
	});

	test("listAll returns rows in insertion order", () => {
		const a = repo.create({
			gitUrl: "https://github.com/x/a.git",
			localPath: "/data/projects/x/a",
			defaultBranch: "main",
			now: new Date("2026-05-08T12:00:00.000Z"),
		});
		const b = repo.create({
			gitUrl: "https://github.com/x/b.git",
			localPath: "/data/projects/x/b",
			defaultBranch: "main",
			now: new Date("2026-05-08T13:00:00.000Z"),
		});
		expect(repo.listAll().map((r) => r.id)).toEqual([a.id, b.id]);
	});

	test("delete removes the row", () => {
		const row = repo.create({
			gitUrl: "https://github.com/x/y.git",
			localPath: "/data/projects/x/y",
			defaultBranch: "main",
		});
		repo.delete(row.id);
		expect(repo.get(row.id)).toBeNull();
	});
});
