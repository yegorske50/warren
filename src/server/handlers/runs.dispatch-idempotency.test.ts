import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { BurrowClient } from "../../burrow-client/index.ts";
import { openDatabase, type WarrenDb } from "../../db/client.ts";
import { createRepos, type Repos } from "../../db/repos/index.ts";
import { NO_AUTH } from "../auth.ts";
import { IdempotencyStore } from "../idempotency.ts";
import { startServer } from "../server.ts";
import type { ServeHandle, ServerDeps } from "../types.ts";
import { depsFor, silentLogger, stub, tcpUrl } from "./runs.test-helpers.ts";

/**
 * `POST /runs` idempotency (warren-d525). A duplicate delivery carrying
 * the same `Idempotency-Key` (within the window, same project) must reuse
 * the original run instead of spawning a second burrow + agent.
 */

/**
 * Burrow client that mints a FRESH burrow + run id on every `POST /burrows`
 * so two real spawns don't collide on a duplicate primary key. The
 * `burrowCreateCount` it returns is the spawn signal the dedupe assertions
 * key on: one logical dispatch must hit `POST /burrows` exactly once.
 */
function countingBurrowClient(workspacePath: string): {
	client: BurrowClient;
	burrowCreateCount: () => number;
} {
	let n = 0;
	const client = new BurrowClient({
		config: { transport: { kind: "unix", path: "/tmp/x.sock" } },
		fetch: stub(async (input, init) => {
			const url = new URL(String(input), "http://localhost");
			const path = url.pathname;
			const method = init?.method ?? "GET";
			if (method === "POST" && path === "/burrows") {
				n += 1;
				const id = `bur_${String(n).padStart(12, "0")}`;
				return new Response(
					JSON.stringify({
						id,
						name: "burrow",
						kind: "task",
						projectRoot: "/data/projects/x/y",
						branch: "main",
						baseBranch: "main",
						originUrl: "https://github.com/x/y.git",
						workspacePath,
						provider: "local",
						sandbox: { network: "open" },
						state: "running",
						createdAt: "2026-05-08T12:00:00Z",
						updatedAt: "2026-05-08T12:00:00Z",
					}),
					{ status: 201, headers: { "content-type": "application/json" } },
				);
			}
			const burrowRunsMatch = path.match(/^\/burrows\/(bur_\w+)\/runs$/);
			if (method === "POST" && burrowRunsMatch) {
				return new Response(
					JSON.stringify({
						id: `run_${String(n).padStart(12, "0")}`,
						burrowId: burrowRunsMatch[1],
						agentId: "refactor-bot",
						prompt: "hello",
						resumeOfRunId: null,
						state: "queued",
						exitCode: null,
						errorMessage: null,
						metadataJson: null,
						queuedAt: "2026-05-08T12:00:01Z",
						startedAt: null,
						completedAt: null,
					}),
					{ status: 201, headers: { "content-type": "application/json" } },
				);
			}
			return new Response(
				JSON.stringify({ error: { code: "not_found", message: `unmatched ${method} ${path}` } }),
				{ status: 404, headers: { "content-type": "application/json" } },
			);
		}),
	});
	return { client, burrowCreateCount: () => n };
}

interface DispatchResponse {
	run: { id: string };
	burrow: { id: string };
}

async function postRun(
	handle: ServeHandle,
	projectId: string,
	idempotencyKey?: string,
): Promise<DispatchResponse> {
	const headers: Record<string, string> = { "content-type": "application/json" };
	if (idempotencyKey !== undefined) headers["Idempotency-Key"] = idempotencyKey;
	const res = await fetch(`${tcpUrl(handle)}/runs`, {
		method: "POST",
		headers,
		body: JSON.stringify({ agent: "refactor-bot", project: projectId, prompt: "hello" }),
	});
	expect(res.status).toBe(201);
	return (await res.json()) as DispatchResponse;
}

describe("POST /runs — Idempotency-Key dedupe (warren-d525)", () => {
	let db: WarrenDb;
	let repos: Repos;
	let handle: ServeHandle | null = null;
	let workspacePath = "";

	beforeEach(async () => {
		db = await openDatabase({ path: ":memory:" });
		repos = createRepos(db);
		await repos.agents.upsert({
			name: "refactor-bot",
			renderedJson: {
				name: "refactor-bot",
				version: 1,
				sections: { system: "you are refactor-bot" },
				resolvedFrom: [],
				frontmatter: {},
			},
		});
		const { mkdtemp } = await import("node:fs/promises");
		const { tmpdir } = await import("node:os");
		const { join } = await import("node:path");
		const projectLocalPath = await mkdtemp(join(tmpdir(), "warren-idem-proj-"));
		workspacePath = await mkdtemp(join(tmpdir(), "warren-idem-ws-"));
		await repos.projects.create({
			gitUrl: "https://github.com/x/y.git",
			localPath: projectLocalPath,
			defaultBranch: "main",
		});
	});

	afterEach(async () => {
		if (handle) {
			await handle.stop();
			handle = null;
		}
		await db.close();
	});

	async function startWith(deps: ServerDeps): Promise<ServeHandle> {
		const h = startServer(deps, {
			transport: { kind: "tcp", hostname: "127.0.0.1", port: 0 },
			auth: NO_AUTH,
			logger: silentLogger,
		});
		handle = h;
		return h;
	}

	test("same key within window spawns once; both responses reference it", async () => {
		const project = (await repos.projects.listAll())[0];
		if (!project) throw new Error("project missing");
		const { client, burrowCreateCount } = countingBurrowClient(workspacePath);
		const deps: ServerDeps = {
			...(await depsFor(repos, client)),
			idempotencyStore: new IdempotencyStore(),
		};
		const h = await startWith(deps);

		const first = await postRun(h, project.id, "dispatch-abc");
		const second = await postRun(h, project.id, "dispatch-abc");

		expect(burrowCreateCount()).toBe(1);
		expect(second.run.id).toBe(first.run.id);
		expect(second.burrow.id).toBe(first.burrow.id);
		expect((await repos.runs.listAll()).length).toBe(1);
	});

	test("different key spawns a new run", async () => {
		const project = (await repos.projects.listAll())[0];
		if (!project) throw new Error("project missing");
		const { client, burrowCreateCount } = countingBurrowClient(workspacePath);
		const deps: ServerDeps = {
			...(await depsFor(repos, client)),
			idempotencyStore: new IdempotencyStore(),
		};
		const h = await startWith(deps);

		const first = await postRun(h, project.id, "key-1");
		const second = await postRun(h, project.id, "key-2");

		expect(burrowCreateCount()).toBe(2);
		expect(second.run.id).not.toBe(first.run.id);
	});

	test("same key after the window expires spawns a new run", async () => {
		const project = (await repos.projects.listAll())[0];
		if (!project) throw new Error("project missing");
		const { client, burrowCreateCount } = countingBurrowClient(workspacePath);
		let clock = 1_000_000;
		const store = new IdempotencyStore({ ttlMs: 1000, now: () => clock });
		const deps: ServerDeps = { ...(await depsFor(repos, client)), idempotencyStore: store };
		const h = await startWith(deps);

		const first = await postRun(h, project.id, "windowed");
		clock += 5000;
		const second = await postRun(h, project.id, "windowed");

		expect(burrowCreateCount()).toBe(2);
		expect(second.run.id).not.toBe(first.run.id);
	});

	test("no header preserves always-spawn behavior", async () => {
		const project = (await repos.projects.listAll())[0];
		if (!project) throw new Error("project missing");
		const { client, burrowCreateCount } = countingBurrowClient(workspacePath);
		const deps: ServerDeps = {
			...(await depsFor(repos, client)),
			idempotencyStore: new IdempotencyStore(),
		};
		const h = await startWith(deps);

		const first = await postRun(h, project.id);
		const second = await postRun(h, project.id);

		expect(burrowCreateCount()).toBe(2);
		expect(second.run.id).not.toBe(first.run.id);
	});

	test("same key but different project is not deduped", async () => {
		const projectA = (await repos.projects.listAll())[0];
		if (!projectA) throw new Error("project missing");
		const { mkdtemp } = await import("node:fs/promises");
		const { tmpdir } = await import("node:os");
		const { join } = await import("node:path");
		const otherLocalPath = await mkdtemp(join(tmpdir(), "warren-idem-proj2-"));
		await repos.projects.create({
			gitUrl: "https://github.com/x/z.git",
			localPath: otherLocalPath,
			defaultBranch: "main",
		});
		const projectB = (await repos.projects.listAll()).find((p) => p.id !== projectA.id);
		if (!projectB) throw new Error("second project missing");

		const { client, burrowCreateCount } = countingBurrowClient(workspacePath);
		const deps: ServerDeps = {
			...(await depsFor(repos, client)),
			idempotencyStore: new IdempotencyStore(),
		};
		const h = await startWith(deps);

		const a = await postRun(h, projectA.id, "shared-key");
		const b = await postRun(h, projectB.id, "shared-key");

		expect(burrowCreateCount()).toBe(2);
		expect(b.run.id).not.toBe(a.run.id);
	});
});
