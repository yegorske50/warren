import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { NotFoundError, StateTransitionError } from "../../core/errors.ts";
import { isId } from "../../core/ids.ts";
import { openDatabase, type WarrenDb } from "../client.ts";
import { AgentsRepo } from "./agents.ts";
import { ProjectsRepo } from "./projects.ts";
import { assertRunTransition, RunsRepo } from "./runs.ts";

describe("assertRunTransition", () => {
	test("queued → running is allowed", () => {
		expect(() => assertRunTransition("queued", "running")).not.toThrow();
	});

	test("running → succeeded|failed|cancelled is allowed", () => {
		expect(() => assertRunTransition("running", "succeeded")).not.toThrow();
		expect(() => assertRunTransition("running", "failed")).not.toThrow();
		expect(() => assertRunTransition("running", "cancelled")).not.toThrow();
	});

	test("queued → cancelled is allowed (steer-before-pickup)", () => {
		expect(() => assertRunTransition("queued", "cancelled")).not.toThrow();
	});

	test("succeeded is terminal", () => {
		expect(() => assertRunTransition("succeeded", "running")).toThrow(StateTransitionError);
		expect(() => assertRunTransition("succeeded", "failed")).toThrow(StateTransitionError);
	});

	test("queued → succeeded is rejected", () => {
		expect(() => assertRunTransition("queued", "succeeded")).toThrow(StateTransitionError);
	});
});

describe("RunsRepo", () => {
	let db: WarrenDb;
	let repo: RunsRepo;
	let agentName: string;
	let projectId: string;

	beforeEach(async () => {
		db = await openDatabase({ path: ":memory:" });
		const agents = new AgentsRepo(db.drizzle);
		const projects = new ProjectsRepo(db.drizzle);
		const a = agents.upsert({ name: "refactor-bot", renderedJson: { sections: {} } });
		const p = projects.create({
			gitUrl: "https://github.com/x/y.git",
			localPath: "/data/projects/x/y",
			defaultBranch: "main",
		});
		agentName = a.name;
		projectId = p.id;
		repo = new RunsRepo(db.drizzle);
	});

	afterEach(() => {
		db.close();
	});

	function spawn(extra: Partial<Parameters<RunsRepo["create"]>[0]> = {}) {
		return repo.create({
			agentName,
			projectId,
			prompt: "fix the flaky test",
			renderedAgentJson: { sections: {} },
			trigger: "manual",
			...extra,
		});
	}

	test("create stores a queued run with a run_ id and no timestamps", () => {
		const row = spawn();
		expect(isId("run", row.id)).toBe(true);
		expect(row.state).toBe("queued");
		expect(row.startedAt).toBeNull();
		expect(row.endedAt).toBeNull();
		expect(row.burrowId).toBeNull();
		expect(row.burrowRunId).toBeNull();
	});

	test("require throws NotFoundError for unknown id", () => {
		expect(() => repo.require("run_doesnotexist")).toThrow(NotFoundError);
	});

	test("attachBurrow tags the row with burrow ids without changing state", () => {
		const row = spawn();
		const tagged = repo.attachBurrow(row.id, {
			burrowId: "bur_xxxxxxxxxxxx",
			burrowRunId: "run_yyyyyyyyyyyy",
		});
		expect(tagged.burrowId).toBe("bur_xxxxxxxxxxxx");
		expect(tagged.burrowRunId).toBe("run_yyyyyyyyyyyy");
		expect(tagged.state).toBe("queued");
		const reread = repo.require(row.id);
		expect(reread.burrowId).toBe("bur_xxxxxxxxxxxx");
	});

	test("markRunning sets state and startedAt", () => {
		const row = spawn();
		const t = new Date("2026-05-08T12:34:56.000Z");
		const running = repo.markRunning(row.id, t);
		expect(running.state).toBe("running");
		expect(running.startedAt).toBe(t.toISOString());
	});

	test("markRunning rejects already-running rows", () => {
		const row = spawn();
		repo.markRunning(row.id);
		expect(() => repo.markRunning(row.id)).toThrow(StateTransitionError);
	});

	test("finalize sets terminal state and endedAt", () => {
		const row = spawn();
		repo.markRunning(row.id);
		const t = new Date("2026-05-08T13:00:00.000Z");
		const done = repo.finalize(row.id, "succeeded", t);
		expect(done.state).toBe("succeeded");
		expect(done.endedAt).toBe(t.toISOString());
	});

	test("finalize rejects an invalid transition (queued → succeeded)", () => {
		const row = spawn();
		expect(() => repo.finalize(row.id, "succeeded")).toThrow(StateTransitionError);
	});

	test("claimById transitions queued → running atomically", () => {
		const row = spawn();
		const claimed = repo.claimById(row.id);
		expect(claimed?.state).toBe("running");
		expect(claimed?.startedAt).not.toBeNull();
	});

	test("claimById returns null when the row is not queued", () => {
		const row = spawn();
		repo.markRunning(row.id);
		expect(repo.claimById(row.id)).toBeNull();
	});

	test("claimById returns null for an unknown id", () => {
		expect(repo.claimById("run_doesnotexist")).toBeNull();
	});

	test("listByProject and listByAgent filter the result set", () => {
		const a = spawn();
		const b = spawn();
		expect(
			repo
				.listByProject(projectId)
				.map((r) => r.id)
				.sort(),
		).toEqual([a.id, b.id].sort());
		expect(
			repo
				.listByAgent(agentName)
				.map((r) => r.id)
				.sort(),
		).toEqual([a.id, b.id].sort());
		expect(repo.listByProject("prj_nope")).toEqual([]);
	});

	test("listByState filters by single state and arrays", () => {
		const a = spawn();
		const b = spawn();
		repo.markRunning(a.id);
		expect(repo.listByState("queued").map((r) => r.id)).toEqual([b.id]);
		expect(
			repo
				.listByState(["queued", "running"])
				.map((r) => r.id)
				.sort(),
		).toEqual([a.id, b.id].sort());
	});
});
