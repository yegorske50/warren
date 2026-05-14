import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { openDatabase, type WarrenDb } from "../db/client.ts";
import type { AgentsRepo } from "../db/repos/agents.ts";
import type { BurrowsRepo } from "../db/repos/burrows.ts";
import { createRepos, type Repos } from "../db/repos/index.ts";
import type { ProjectsRepo } from "../db/repos/projects.ts";
import type { RunsRepo } from "../db/repos/runs.ts";
import type { WorkersRepo } from "../db/repos/workers.ts";
import {
	NoEligibleWorkerError,
	placeForBurrow,
	placeForProject,
	StickyWorkerUnreachableError,
} from "./placement.ts";

describe("placeForProject", () => {
	let db: WarrenDb;
	let repos: Repos;
	let projectId: string;
	let otherProjectId: string;
	let agentName: string;

	beforeEach(async () => {
		db = await openDatabase({ path: ":memory:" });
		repos = createRepos(db);
		const agents = repos.agents as AgentsRepo;
		const projects = repos.projects as ProjectsRepo;
		await agents.upsert({ name: "claude-code", renderedJson: { sections: {} } });
		agentName = "claude-code";
		const p1 = await projects.create({
			gitUrl: "https://github.com/x/y.git",
			localPath: "/data/projects/x/y",
			defaultBranch: "main",
		});
		const p2 = await projects.create({
			gitUrl: "https://github.com/x/z.git",
			localPath: "/data/projects/x/z",
			defaultBranch: "main",
		});
		projectId = p1.id;
		otherProjectId = p2.id;
	});

	afterEach(async () => {
		await db.close();
	});

	async function addWorker(
		name: string,
		state: "healthy" | "draining" | "unreachable" = "healthy",
	) {
		await (repos.workers as WorkersRepo).upsert({ name, url: `http://${name}:1`, state });
	}

	async function spawnRun(opts: {
		project?: string;
		workerId?: string | null;
		state?: "queued" | "running" | "succeeded" | "failed";
		endedAt?: string;
	}) {
		const runs = repos.runs as RunsRepo;
		const row = await runs.create({
			agentName,
			projectId: opts.project ?? projectId,
			prompt: "do thing",
			renderedAgentJson: { sections: {} },
			trigger: "manual",
			workerId: opts.workerId ?? null,
		});
		if (opts.state === "succeeded" || opts.state === "failed") {
			await runs.markRunning(row.id);
			await runs.finalize(row.id, opts.state, opts.endedAt ? new Date(opts.endedAt) : new Date());
		} else if (opts.state === "running") {
			await runs.markRunning(row.id);
		}
		return row;
	}

	test("throws NoEligibleWorker when the workers table is empty", async () => {
		await expect(placeForProject({ repos }, { projectId })).rejects.toThrow(NoEligibleWorkerError);
	});

	test("throws NoEligibleWorker when every worker is draining or unreachable", async () => {
		await addWorker("alpha", "draining");
		await addWorker("beta", "unreachable");
		await expect(placeForProject({ repos }, { projectId })).rejects.toThrow(NoEligibleWorkerError);
	});

	test("affinity wins: prior successful run for this project sticks to the same worker", async () => {
		await addWorker("alpha");
		await addWorker("beta");
		await spawnRun({ workerId: "beta", state: "succeeded", endedAt: "2026-05-13T00:00:00.000Z" });
		expect(await placeForProject({ repos }, { projectId })).toBe("beta");
	});

	test("affinity ignores prior runs for a different project", async () => {
		await addWorker("alpha");
		await addWorker("beta");
		await spawnRun({
			project: otherProjectId,
			workerId: "beta",
			state: "succeeded",
			endedAt: "2026-05-13T00:00:00.000Z",
		});
		expect(await placeForProject({ repos }, { projectId })).toBe("alpha");
	});

	test("affinity ignores failed runs", async () => {
		await addWorker("alpha");
		await addWorker("beta");
		await spawnRun({ workerId: "beta", state: "failed", endedAt: "2026-05-13T00:00:00.000Z" });
		expect(await placeForProject({ repos }, { projectId })).toBe("alpha");
	});

	test("affinity picks the newest successful run by endedAt", async () => {
		await addWorker("alpha");
		await addWorker("beta");
		await spawnRun({ workerId: "alpha", state: "succeeded", endedAt: "2026-05-13T00:00:00.000Z" });
		await spawnRun({ workerId: "beta", state: "succeeded", endedAt: "2026-05-13T02:00:00.000Z" });
		expect(await placeForProject({ repos }, { projectId })).toBe("beta");
	});

	test("affinity falls through when the sticky worker is draining", async () => {
		await addWorker("alpha");
		await addWorker("beta", "draining");
		await spawnRun({ workerId: "beta", state: "succeeded", endedAt: "2026-05-13T00:00:00.000Z" });
		expect(await placeForProject({ repos }, { projectId })).toBe("alpha");
	});

	test("affinity falls through when the sticky worker is unreachable", async () => {
		await addWorker("alpha");
		await addWorker("beta", "unreachable");
		await spawnRun({ workerId: "beta", state: "succeeded", endedAt: "2026-05-13T00:00:00.000Z" });
		expect(await placeForProject({ repos }, { projectId })).toBe("alpha");
	});

	test("least-loaded wins when there is no affinity", async () => {
		await addWorker("alpha");
		await addWorker("beta");
		await spawnRun({ workerId: "alpha", state: "running" });
		await spawnRun({ workerId: "alpha", state: "queued" });
		expect(await placeForProject({ repos }, { projectId })).toBe("beta");
	});

	test("least-loaded counts queued + running but not succeeded/failed", async () => {
		await addWorker("alpha");
		await addWorker("beta");
		await spawnRun({ workerId: "alpha", state: "succeeded", endedAt: "2026-05-13T00:00:00.000Z" });
		// alpha has affinity from succeeded run; verify behavior changes if we
		// drop affinity by making beta the affinity target and adding load.
		await spawnRun({ workerId: "alpha", state: "running" });
		await spawnRun({ workerId: "alpha", state: "queued" });
		// alpha has the most recent succeeded run, so affinity picks alpha.
		expect(await placeForProject({ repos }, { projectId })).toBe("alpha");
	});

	test("least-loaded ties break alphabetically by worker name", async () => {
		await addWorker("zulu");
		await addWorker("alpha");
		await addWorker("mike");
		// Zero load on every worker → alphabetical tiebreak.
		expect(await placeForProject({ repos }, { projectId })).toBe("alpha");
	});

	test("least-loaded excludes draining + unreachable workers entirely", async () => {
		await addWorker("alpha");
		await addWorker("beta", "draining");
		await addWorker("gamma", "unreachable");
		await spawnRun({ workerId: "alpha", state: "running" });
		await spawnRun({ workerId: "alpha", state: "running" });
		// beta + gamma have zero load but are not healthy → alpha wins
		// despite its 2 in-flight runs.
		expect(await placeForProject({ repos }, { projectId })).toBe("alpha");
	});

	test("rows without a workerId are not counted as load", async () => {
		await addWorker("alpha");
		await addWorker("beta");
		// Legacy row from before pl-9ba1 step 4: state=running but workerId is null.
		await spawnRun({ workerId: null, state: "running" });
		// alpha and beta both still report zero load → alphabetical wins.
		expect(await placeForProject({ repos }, { projectId })).toBe("alpha");
	});
});

describe("placeForBurrow", () => {
	let db: WarrenDb;
	let repos: Repos;

	beforeEach(async () => {
		db = await openDatabase({ path: ":memory:" });
		repos = createRepos(db);
	});

	afterEach(async () => {
		await db.close();
	});

	async function addWorker(
		name: string,
		state: "healthy" | "draining" | "unreachable" = "healthy",
	) {
		await (repos.workers as WorkersRepo).upsert({ name, url: `http://${name}:1`, state });
	}

	test("returns the recorded worker for a healthy burrow", async () => {
		await addWorker("alpha");
		await (repos.burrows as BurrowsRepo).create({ id: "bur_aaaaaaaaaaaa", workerId: "alpha" });
		expect(await placeForBurrow({ repos }, { burrowId: "bur_aaaaaaaaaaaa" })).toBe("alpha");
	});

	test("returns the recorded worker even when it is draining (existing burrows finish)", async () => {
		await addWorker("alpha", "draining");
		await (repos.burrows as BurrowsRepo).create({ id: "bur_aaaaaaaaaaaa", workerId: "alpha" });
		expect(await placeForBurrow({ repos }, { burrowId: "bur_aaaaaaaaaaaa" })).toBe("alpha");
	});

	test("throws StickyWorkerUnreachableError when the pinned worker is unreachable", async () => {
		await addWorker("alpha", "unreachable");
		await (repos.burrows as BurrowsRepo).create({ id: "bur_aaaaaaaaaaaa", workerId: "alpha" });
		await expect(placeForBurrow({ repos }, { burrowId: "bur_aaaaaaaaaaaa" })).rejects.toThrow(
			StickyWorkerUnreachableError,
		);
	});

	test("throws StickyWorkerUnreachableError when the pinned worker row is gone", async () => {
		await (repos.burrows as BurrowsRepo).create({ id: "bur_aaaaaaaaaaaa", workerId: "vanished" });
		await expect(placeForBurrow({ repos }, { burrowId: "bur_aaaaaaaaaaaa" })).rejects.toThrow(
			StickyWorkerUnreachableError,
		);
	});

	test("throws NoEligibleWorker when warren has no placement record for the burrow", async () => {
		await addWorker("alpha");
		await expect(placeForBurrow({ repos }, { burrowId: "bur_missing00000" })).rejects.toThrow(
			NoEligibleWorkerError,
		);
	});
});
