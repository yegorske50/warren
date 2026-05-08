import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { BurrowClient } from "../burrow-client/index.ts";
import { openDatabase, type WarrenDb } from "../db/client.ts";
import { createRepos, type Repos } from "../db/repos/index.ts";
import {
	type BridgeRunStreamInput,
	type BridgeRunStreamResult,
	RunEventBroker,
} from "../runs/index.ts";
import { bootBridges, createBridgeRegistry } from "./bridges.ts";

function stub(
	impl: (input: URL | RequestInfo, init?: RequestInit) => Promise<Response>,
): typeof fetch {
	return impl as unknown as typeof fetch;
}

function makeBurrowClient(): BurrowClient {
	return new BurrowClient({
		config: { transport: { kind: "unix", path: "/tmp/x.sock" } },
		fetch: stub(
			async () =>
				new Response(JSON.stringify({ error: { code: "not_found", message: "stub" } }), {
					status: 404,
				}),
		),
	});
}

describe("createBridgeRegistry", () => {
	let db: WarrenDb;
	let repos: Repos;

	beforeEach(async () => {
		db = await openDatabase({ path: ":memory:" });
		repos = createRepos(db);
	});

	afterEach(() => {
		db.close();
	});

	test("start() invokes the bridge factory once per runId", () => {
		const calls: BridgeRunStreamInput[] = [];
		const registry = createBridgeRegistry({
			repos,
			broker: new RunEventBroker(),
			burrowClient: makeBurrowClient(),
			bridge: async (input) => {
				calls.push(input);
				return { written: 0, skipped: 0, errored: false };
			},
		});

		registry.start("run_aaaaaaaaaaaa", "burrow_run_xxxxxxxxxx");
		registry.start("run_aaaaaaaaaaaa", "burrow_run_xxxxxxxxxx"); // idempotent
		registry.start("run_bbbbbbbbbbbb", "burrow_run_yyyyyyyyyy");

		expect(calls.length).toBe(2);
		expect(registry.size()).toBe(2);
	});

	test("resolved bridges auto-detach", async () => {
		const resolvers: Array<() => void> = [];
		const registry = createBridgeRegistry({
			repos,
			broker: new RunEventBroker(),
			burrowClient: makeBurrowClient(),
			bridge: () =>
				new Promise<BridgeRunStreamResult>((resolve) => {
					resolvers.push(() => resolve({ written: 0, skipped: 0, errored: false }));
				}),
		});

		registry.start("run_aaaaaaaaaaaa", "burrow_run_xxxxxxxxxx");
		expect(registry.size()).toBe(1);

		for (const r of resolvers) r();
		await new Promise((r) => setTimeout(r, 0));
		expect(registry.size()).toBe(0);
	});

	test("stopAll() aborts in-flight bridges and waits for drain", async () => {
		let abortObserved = false;
		const registry = createBridgeRegistry({
			repos,
			broker: new RunEventBroker(),
			burrowClient: makeBurrowClient(),
			bridge: (input) =>
				new Promise<BridgeRunStreamResult>((resolve) => {
					input.signal?.addEventListener("abort", () => {
						abortObserved = true;
						resolve({ written: 0, skipped: 0, errored: false });
					});
				}),
		});

		registry.start("run_aaaaaaaaaaaa", "burrow_run_xxxxxxxxxx");
		await registry.stopAll();
		expect(abortObserved).toBe(true);
		expect(registry.size()).toBe(0);
	});
});

describe("bootBridges", () => {
	let db: WarrenDb;
	let repos: Repos;

	beforeEach(async () => {
		db = await openDatabase({ path: ":memory:" });
		repos = createRepos(db);
		repos.agents.upsert({ name: "refactor-bot", renderedJson: { name: "refactor-bot" } });
		repos.projects.create({
			gitUrl: "https://github.com/x/y.git",
			localPath: "/data/projects/x/y",
			defaultBranch: "main",
		});
	});

	afterEach(() => {
		db.close();
	});

	test("resumes runs with a burrow_run_id; skips ones without", async () => {
		const project = repos.projects.listAll()[0];
		if (!project) throw new Error("project missing");

		const r1 = repos.runs.create({
			agentName: "refactor-bot",
			projectId: project.id,
			prompt: "p",
			renderedAgentJson: { sections: { system: "x" } },
			trigger: "manual",
		});
		repos.runs.attachBurrow(r1.id, {
			burrowId: "bur_xxxxxxxxxxxx",
			burrowRunId: "run_zzzzzzzzzzzz",
		});

		const r2 = repos.runs.create({
			agentName: "refactor-bot",
			projectId: project.id,
			prompt: "p",
			renderedAgentJson: { sections: { system: "x" } },
			trigger: "manual",
		});
		// r2 has no burrow_run_id — partial spawn

		const calls: string[] = [];
		const result = bootBridges({
			repos,
			broker: new RunEventBroker(),
			burrowClient: makeBurrowClient(),
			bridge: async (input) => {
				calls.push(input.runId);
				return { written: 0, skipped: 0, errored: false };
			},
		});

		expect(result.resumed.map((r) => r.runId)).toEqual([r1.id]);
		expect(result.skipped.map((s) => s.runId)).toEqual([r2.id]);
		expect(calls).toEqual([r1.id]);
		await result.registry.stopAll();
	});

	test("returns an empty registry when no active runs", async () => {
		const result = bootBridges({
			repos,
			broker: new RunEventBroker(),
			burrowClient: makeBurrowClient(),
		});
		expect(result.resumed.length).toBe(0);
		expect(result.skipped.length).toBe(0);
		expect(result.registry.size()).toBe(0);
		await result.registry.stopAll();
	});
});
