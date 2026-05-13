import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { Burrow, Run as BurrowRun } from "@os-eco/burrow-cli";
import { BurrowClient, BurrowUnreachableError } from "../burrow-client/index.ts";
import { NotFoundError, ValidationError } from "../core/errors.ts";
import { isId } from "../core/ids.ts";
import { openDatabase, type WarrenDb } from "../db/client.ts";
import { createRepos, type Repos } from "../db/repos/index.ts";
import type { AgentDefinition } from "../registry/schema.ts";
import { RunSpawnError } from "./errors.ts";
import { composeDispatchPrompt, spawnRun } from "./spawn.ts";

// `typeof fetch` requires a `preconnect` method we don't exercise in tests; cast
// each stub so callers can pass a plain async function.
function stub(
	impl: (input: URL | RequestInfo, init?: RequestInit) => Promise<Response>,
): typeof fetch {
	return impl as unknown as typeof fetch;
}

function jsonResponse(status: number, body: unknown): Response {
	return new Response(JSON.stringify(body), {
		status,
		headers: { "content-type": "application/json" },
	});
}

interface BurrowFetchPlan {
	burrow?: Partial<Burrow>;
	run?: Partial<BurrowRun>;
	burrowsUpStatus?: number;
	burrowsUpBody?: unknown;
	runsCreateStatus?: number;
	runsCreateBody?: unknown;
	destroyStatus?: number;
	destroyBody?: unknown;
}

interface RecordedCall {
	method: string;
	path: string;
	body: unknown;
}

function makeBurrowClient(plan: BurrowFetchPlan = {}): {
	client: BurrowClient;
	calls: RecordedCall[];
} {
	const calls: RecordedCall[] = [];
	const fetchImpl = stub(async (input, init) => {
		const url = new URL(String(input), "http://localhost");
		const path = url.pathname;
		const method = init?.method ?? "GET";
		const body = typeof init?.body === "string" ? JSON.parse(init.body) : undefined;
		calls.push({ method, path, body });
		if (method === "POST" && path === "/burrows") {
			const burrow: Burrow = {
				id: "bur_aaaaaaaaaaaa",
				parentId: null,
				kind: "task",
				name: null,
				projectRoot: "/data/projects/x/y",
				workspacePath: "/data/burrow/workspaces/bur_aaaaaaaaaaaa",
				branch: "warren/run/abc",
				provider: "local",
				providerStateJson: null,
				profileJson: {},
				state: "active",
				createdAt: new Date("2026-05-08T12:00:00Z"),
				updatedAt: new Date("2026-05-08T12:00:00Z"),
				destroyedAt: null,
				...plan.burrow,
			};
			return jsonResponse(
				plan.burrowsUpStatus ?? 201,
				plan.burrowsUpBody ?? serializeBurrow(burrow),
			);
		}
		if (method === "POST" && path.match(/^\/burrows\/[^/]+\/runs$/)) {
			const run: BurrowRun = {
				id: "run_zzzzzzzzzzzz",
				burrowId: "bur_aaaaaaaaaaaa",
				agentId: "refactor-bot",
				prompt: "fix the test",
				resumeOfRunId: null,
				state: "queued",
				exitCode: null,
				errorMessage: null,
				metadataJson: null,
				queuedAt: new Date("2026-05-08T12:00:01Z"),
				startedAt: null,
				completedAt: null,
				...plan.run,
			};
			return jsonResponse(plan.runsCreateStatus ?? 201, plan.runsCreateBody ?? serializeRun(run));
		}
		if (method === "DELETE" && path.match(/^\/burrows\/[^/]+$/)) {
			return jsonResponse(
				plan.destroyStatus ?? 200,
				plan.destroyBody ?? { burrowId: "bur_aaaaaaaaaaaa", archived: false },
			);
		}
		return jsonResponse(404, {
			error: { code: "not_found", message: `unmatched ${method} ${path}` },
		});
	});
	const client = new BurrowClient({
		config: { transport: { kind: "unix", path: "/tmp/x.sock" } },
		fetch: fetchImpl,
	});
	return { client, calls };
}

function serializeBurrow(b: Burrow): unknown {
	return {
		...b,
		createdAt: b.createdAt.toISOString(),
		updatedAt: b.updatedAt.toISOString(),
		destroyedAt: b.destroyedAt?.toISOString() ?? null,
	};
}

function serializeRun(r: BurrowRun): unknown {
	return {
		...r,
		queuedAt: r.queuedAt.toISOString(),
		startedAt: r.startedAt?.toISOString() ?? null,
		completedAt: r.completedAt?.toISOString() ?? null,
	};
}

/**
 * Pull `.canopy/agent.json` out of the seed payload that rode on POST /burrows
 * and return its `frontmatter`. The seed payload travels as part of
 * `burrows.up({ seed: { files } })`, so the canopy envelope is recoverable
 * from the recorded request body without a separate seam.
 */
function readCanopyFrontmatter(calls: readonly RecordedCall[]): Record<string, unknown> {
	const up = calls.find((c) => c.method === "POST" && c.path === "/burrows");
	const seed = (
		up?.body as { seed?: { files?: ReadonlyArray<{ path: string; contents: string }> } }
	)?.seed;
	const canopy = seed?.files?.find((f) => f.path === ".canopy/agent.json");
	if (canopy === undefined) throw new Error(".canopy/agent.json missing from seed payload");
	const parsed = JSON.parse(canopy.contents) as { frontmatter?: Record<string, unknown> };
	return parsed.frontmatter ?? {};
}

function makeAgentJson(overrides: Partial<AgentDefinition> = {}): AgentDefinition {
	return {
		name: "refactor-bot",
		version: 1,
		sections: {
			system: "be a refactor agent",
			...(overrides.sections ?? {}),
		},
		resolvedFrom: [],
		frontmatter: {},
		...overrides,
	};
}

describe("spawnRun", () => {
	let db: WarrenDb;
	let repos: Repos;

	beforeEach(async () => {
		db = await openDatabase({ path: ":memory:" });
		repos = createRepos(db);
		repos.agents.upsert({ name: "refactor-bot", renderedJson: makeAgentJson() });
		repos.projects.create({
			id: "prj_xxxxxxxxxxxx",
			gitUrl: "https://github.com/x/y.git",
			localPath: "/data/projects/x/y",
			defaultBranch: "main",
		});
	});

	afterEach(() => {
		db.close();
	});

	test("rejects an empty prompt before touching db or burrow", async () => {
		const { client, calls } = makeBurrowClient();
		await expect(
			spawnRun({
				repos,
				burrowClient: client,
				agentName: "refactor-bot",
				projectId: "prj_xxxxxxxxxxxx",
				prompt: "   ",
			}),
		).rejects.toBeInstanceOf(ValidationError);
		expect(calls).toHaveLength(0);
		expect(repos.runs.listAll()).toHaveLength(0);
	});

	test("throws NotFoundError when the agent is not registered", async () => {
		const { client, calls } = makeBurrowClient();
		await expect(
			spawnRun({
				repos,
				burrowClient: client,
				agentName: "no-such-agent",
				projectId: "prj_xxxxxxxxxxxx",
				prompt: "fix it",
			}),
		).rejects.toBeInstanceOf(NotFoundError);
		expect(calls).toHaveLength(0);
	});

	test("throws NotFoundError when the project does not exist", async () => {
		const { client } = makeBurrowClient();
		await expect(
			spawnRun({
				repos,
				burrowClient: client,
				agentName: "refactor-bot",
				projectId: "prj_doesnotexist",
				prompt: "fix it",
			}),
		).rejects.toBeInstanceOf(NotFoundError);
	});

	test("end-to-end: creates the warren run, provisions+seeds the burrow atomically, dispatches", async () => {
		const { client, calls } = makeBurrowClient();
		const result = await spawnRun({
			repos,
			burrowClient: client,
			agentName: "refactor-bot",
			projectId: "prj_xxxxxxxxxxxx",
			prompt: "fix the flaky test",
		});

		// Warren run row
		expect(isId("run", result.run.id)).toBe(true);
		expect(result.run.state).toBe("queued");
		expect(result.run.burrowId).toBe("bur_aaaaaaaaaaaa");
		expect(result.run.burrowRunId).toBe("run_zzzzzzzzzzzz");
		const reread = repos.runs.require(result.run.id);
		expect(reread.burrowId).toBe("bur_aaaaaaaaaaaa");
		expect(reread.burrowRunId).toBe("run_zzzzzzzzzzzz");

		// Frozen rendered agent JSON survives the round-trip
		const stored = reread.renderedAgentJson as { name: string; sections: Record<string, string> };
		expect(stored.name).toBe("refactor-bot");
		expect(stored.sections.system).toBe("be a refactor agent");

		// Two HTTP calls: provision-with-seed, then dispatch. The seed.files
		// payload rides on POST /burrows so provisioning + workspace drops are
		// atomic — burrow rolls back if any file is rejected (R-07).
		expect(calls).toHaveLength(2);
		expect(calls[1]).toEqual({
			method: "POST",
			path: "/burrows/bur_aaaaaaaaaaaa/runs",
			body: {
				agentId: "refactor-bot",
				prompt: "be a refactor agent\n\n---\n\nfix the flaky test",
				metadata: { frontmatter: {} },
			},
		});

		// POST /burrows body: agents + seed.files payload (no half-seeded
		// workspace ever observable on warren's side).
		const upBody = calls[0]?.body as {
			projectRoot: string;
			originUrl: string;
			agents: readonly string[];
			seed?: { files: ReadonlyArray<{ path: string; contents: string }> };
		};
		expect(upBody.projectRoot).toBe("/data/projects/x/y");
		expect(upBody.originUrl).toBe("https://github.com/x/y.git");
		expect(upBody.agents).toEqual(["refactor-bot"]);
		const seededPaths = (upBody.seed?.files ?? []).map((f) => f.path);
		expect(seededPaths).toContain(".canopy/agent.json");
	});

	test("forwards burrow_config network and metadata onto the burrow calls", async () => {
		repos.agents.upsert({
			name: "refactor-bot",
			renderedJson: makeAgentJson({
				sections: {
					system: "s",
					burrow_config: `[sandbox]\nnetwork = "restricted"`,
				},
			}),
		});

		const { client, calls } = makeBurrowClient();
		await spawnRun({
			repos,
			burrowClient: client,
			agentName: "refactor-bot",
			projectId: "prj_xxxxxxxxxxxx",
			prompt: "p",
			metadata: { runByOperator: "alice" },
		});

		expect(calls[0]).toMatchObject({
			method: "POST",
			path: "/burrows",
			body: {
				projectRoot: "/data/projects/x/y",
				originUrl: "https://github.com/x/y.git",
				network: "restricted",
				agents: ["refactor-bot"],
			},
		});
		expect(calls[1]).toMatchObject({
			method: "POST",
			path: "/burrows/bur_aaaaaaaaaaaa/runs",
			body: {
				agentId: "refactor-bot",
				prompt: "s\n\n---\n\np",
				metadata: { runByOperator: "alice", frontmatter: {} },
			},
		});
	});

	test("forwards agent.frontmatter as burrow run metadata so piRuntime gets provider/model (warren-d34e)", async () => {
		repos.agents.upsert({
			name: "pi",
			renderedJson: makeAgentJson({
				name: "pi",
				frontmatter: { source: "builtin", provider: "anthropic", model: "claude-opus-4-7" },
			}),
		});
		const { client, calls } = makeBurrowClient();
		await spawnRun({
			repos,
			burrowClient: client,
			agentName: "pi",
			projectId: "prj_xxxxxxxxxxxx",
			prompt: "p",
		});

		const dispatch = calls.find((c) => c.path === "/burrows/bur_aaaaaaaaaaaa/runs");
		expect(dispatch).toBeDefined();
		const body = dispatch?.body as { metadata: { frontmatter: Record<string, unknown> } };
		expect(body.metadata.frontmatter.provider).toBe("anthropic");
		expect(body.metadata.frontmatter.model).toBe("claude-opus-4-7");
		expect(body.metadata.frontmatter.source).toBe("builtin");
	});

	test("dispatch metadata frontmatter reflects per-run + project-default overrides (warren-d34e)", async () => {
		repos.agents.upsert({
			name: "pi",
			renderedJson: makeAgentJson({
				name: "pi",
				frontmatter: { provider: "pi", model: "pi-default" },
			}),
		});
		const { client, calls } = makeBurrowClient();
		await spawnRun({
			repos,
			burrowClient: client,
			agentName: "pi",
			projectId: "prj_xxxxxxxxxxxx",
			prompt: "p",
			providerOverride: "openai",
			warrenConfigs: {
				get: async () => ({
					triggers: null,
					defaults: { defaultProvider: "anthropic", defaultModel: "claude-opus-4-7" },
					errors: [],
				}),
				invalidate: () => undefined,
				clear: () => undefined,
				size: () => 0,
			},
		});

		const dispatch = calls.find((c) => c.path === "/burrows/bur_aaaaaaaaaaaa/runs");
		const body = dispatch?.body as { metadata: { frontmatter: Record<string, unknown> } };
		// Operator override wins for provider; project default wins for model.
		expect(body.metadata.frontmatter.provider).toBe("openai");
		expect(body.metadata.frontmatter.model).toBe("claude-opus-4-7");
	});

	test("rolls back: cancels the warren row when burrow rejects the seed payload (atomic rollback, R-07)", async () => {
		// A bad seed file makes burrow's `POST /burrows` reject before the
		// burrow ever materializes — the rollback is on burrow's side, so
		// warren never sees a burrow id and there's no DELETE to fire.
		const { client, calls } = makeBurrowClient({
			burrowsUpStatus: 422,
			burrowsUpBody: {
				error: {
					code: "validation_error",
					message: "seed file rejected: workspace path escapes root",
				},
			},
		});
		await expect(
			spawnRun({
				repos,
				burrowClient: client,
				agentName: "refactor-bot",
				projectId: "prj_xxxxxxxxxxxx",
				prompt: "p",
			}),
		).rejects.toBeDefined();

		// Warren row still exists in cancelled state with no burrow attached.
		const rows = repos.runs.listAll();
		expect(rows).toHaveLength(1);
		expect(rows[0]?.state).toBe("cancelled");
		expect(rows[0]?.burrowId).toBeNull();
		expect(rows[0]?.burrowRunId).toBeNull();

		// Only POST /burrows fired; no DELETE (burrow rolled back on its side)
		// and no /runs dispatch.
		const methods = calls.map((c) => `${c.method} ${c.path}`);
		expect(methods).toEqual(["POST /burrows"]);
	});

	test("rolls back when burrow dispatch fails", async () => {
		const { client, calls } = makeBurrowClient({
			runsCreateStatus: 500,
			runsCreateBody: { error: { code: "internal_error", message: "boom" } },
		});
		await expect(
			spawnRun({
				repos,
				burrowClient: client,
				agentName: "refactor-bot",
				projectId: "prj_xxxxxxxxxxxx",
				prompt: "p",
			}),
		).rejects.toBeDefined();

		const rows = repos.runs.listAll();
		expect(rows).toHaveLength(1);
		expect(rows[0]?.state).toBe("cancelled");
		expect(rows[0]?.burrowId).toBe("bur_aaaaaaaaaaaa");
		expect(rows[0]?.burrowRunId).toBeNull();
		const methods = calls.map((c) => `${c.method} ${c.path}`);
		expect(methods).toContain("DELETE /burrows/bur_aaaaaaaaaaaa");
	});

	test("propagates burrow transport failures and leaves no warren row attached to a burrow", async () => {
		const errFetch = stub(async () => {
			const e = new TypeError("fetch failed");
			(e as unknown as { cause: { code: string } }).cause = { code: "ECONNREFUSED" };
			throw e;
		});
		const client = new BurrowClient({
			config: { transport: { kind: "unix", path: "/tmp/x.sock" } },
			fetch: errFetch,
		});
		await expect(
			spawnRun({
				repos,
				burrowClient: client,
				agentName: "refactor-bot",
				projectId: "prj_xxxxxxxxxxxx",
				prompt: "p",
			}),
		).rejects.toBeInstanceOf(BurrowUnreachableError);

		const rows = repos.runs.listAll();
		expect(rows).toHaveLength(1);
		expect(rows[0]?.state).toBe("cancelled");
		expect(rows[0]?.burrowId).toBeNull();
	});

	test("readCachedAgent: handles older cached envelopes (raw cn render output)", async () => {
		// Older registry refresh paths may have stored the raw envelope rather
		// than the parsed AgentDefinition. The spawn flow re-parses on read so
		// stale caches don't crash the flow.
		repos.agents.upsert({
			name: "refactor-bot",
			renderedJson: {
				success: true,
				command: "render",
				name: "refactor-bot",
				version: 2,
				sections: [{ name: "system", body: "s" }],
			},
		});
		const { client } = makeBurrowClient();
		const result = await spawnRun({
			repos,
			burrowClient: client,
			agentName: "refactor-bot",
			projectId: "prj_xxxxxxxxxxxx",
			prompt: "p",
		});
		const stored = result.run.renderedAgentJson as { sections: Record<string, string> };
		expect(stored.sections.system).toBe("s");
	});

	test("rejects a corrupted cached agent JSON with RunSpawnError", async () => {
		repos.agents.upsert({
			name: "refactor-bot",
			renderedJson: { name: "refactor-bot", version: 1, sections: { system: 42 } },
		});
		const { client } = makeBurrowClient();
		await expect(
			spawnRun({
				repos,
				burrowClient: client,
				agentName: "refactor-bot",
				projectId: "prj_xxxxxxxxxxxx",
				prompt: "p",
			}),
		).rejects.toBeInstanceOf(RunSpawnError);
	});

	test("refreshes the project clone before provisioning burrow when projectsConfig + projectSpawn are wired", async () => {
		const { client, calls } = makeBurrowClient();
		let refreshCalled = false;
		let refreshRef: string | undefined;
		await spawnRun({
			repos,
			burrowClient: client,
			agentName: "refactor-bot",
			projectId: "prj_xxxxxxxxxxxx",
			prompt: "p",
			projectsConfig: { root: "/data/projects", gitBinary: "git" },
			projectSpawn: async () => ({ stdout: "", stderr: "", exitCode: 0 }),
			refreshProjectFn: async (input) => {
				refreshCalled = true;
				refreshRef = input.ref;
				const updated = repos.projects.recordRefresh({
					id: input.id,
					headSha: "feedface".repeat(5),
				});
				return { project: updated, headSha: "feedface".repeat(5), ref: input.ref ?? "main" };
			},
		});

		expect(refreshCalled).toBe(true);
		expect(refreshRef).toBeUndefined(); // defaults to row's defaultBranch inside refreshProject
		// Burrow was provisioned with the project's localPath after refresh
		expect(calls[0]?.body).toMatchObject({ projectRoot: "/data/projects/x/y" });

		// HEAD sha was persisted onto the project row
		const persisted = repos.projects.require("prj_xxxxxxxxxxxx");
		expect(persisted.lastHeadSha).toBe("feedface".repeat(5));
		expect(persisted.lastFetchedAt).not.toBeNull();
	});

	test("forwards an explicit ref override into refreshProjectFn", async () => {
		const { client } = makeBurrowClient();
		let receivedRef: string | undefined;
		await spawnRun({
			repos,
			burrowClient: client,
			agentName: "refactor-bot",
			projectId: "prj_xxxxxxxxxxxx",
			prompt: "p",
			ref: "feature/x",
			projectsConfig: { root: "/data/projects", gitBinary: "git" },
			projectSpawn: async () => ({ stdout: "", stderr: "", exitCode: 0 }),
			refreshProjectFn: async (input) => {
				receivedRef = input.ref;
				const updated = repos.projects.recordRefresh({
					id: input.id,
					headSha: "abcd".repeat(10),
				});
				return { project: updated, headSha: "abcd".repeat(10), ref: input.ref ?? "" };
			},
		});
		expect(receivedRef).toBe("feature/x");
	});

	test("aborts spawn when refresh fails — no warren row, no burrow", async () => {
		const { client, calls } = makeBurrowClient();
		await expect(
			spawnRun({
				repos,
				burrowClient: client,
				agentName: "refactor-bot",
				projectId: "prj_xxxxxxxxxxxx",
				prompt: "p",
				projectsConfig: { root: "/data/projects", gitBinary: "git" },
				projectSpawn: async () => ({ stdout: "", stderr: "", exitCode: 0 }),
				refreshProjectFn: async () => {
					throw new Error("git fetch failed");
				},
			}),
		).rejects.toBeDefined();

		expect(repos.runs.listAll()).toHaveLength(0);
		expect(calls).toHaveLength(0);
	});

	test("folds providerOverride + modelOverride onto frontmatter before freeze and seed (warren-f8c0)", async () => {
		repos.agents.upsert({
			name: "pi",
			renderedJson: makeAgentJson({
				name: "pi",
				frontmatter: { source: "builtin", provider: "anthropic", model: "claude-sonnet-4-6" },
			}),
		});
		const { client, calls } = makeBurrowClient();
		const result = await spawnRun({
			repos,
			burrowClient: client,
			agentName: "pi",
			projectId: "prj_xxxxxxxxxxxx",
			prompt: "run",
			providerOverride: "openai",
			modelOverride: "gpt-4o",
		});

		// The seed payload shipped on POST /burrows carries the override-applied
		// agent envelope verbatim (buildSeedFiles materializes the resolved
		// frontmatter into `.canopy/agent.json`).
		const seededFm = readCanopyFrontmatter(calls);
		expect(seededFm.provider).toBe("openai");
		expect(seededFm.model).toBe("gpt-4o");
		// Original builtin frontmatter preserved
		expect(seededFm.source).toBe("builtin");

		// Frozen rendered_agent_json carries the overrides
		const stored = repos.runs.require(result.run.id).renderedAgentJson as {
			frontmatter: Record<string, unknown>;
		};
		expect(stored.frontmatter.provider).toBe("openai");
		expect(stored.frontmatter.model).toBe("gpt-4o");

		// Cached agent row is untouched — the override is per-run, not per-agent
		const reread = repos.agents.require("pi").renderedJson as {
			frontmatter: Record<string, unknown>;
		};
		expect(reread.frontmatter.provider).toBe("anthropic");
		expect(reread.frontmatter.model).toBe("claude-sonnet-4-6");
	});

	test("falls back to .warren/defaults.json provider/model when no per-run override (warren-618b)", async () => {
		repos.agents.upsert({
			name: "pi",
			renderedJson: makeAgentJson({
				name: "pi",
				frontmatter: { source: "builtin", provider: "pi", model: "pi-default" },
			}),
		});
		const { client, calls } = makeBurrowClient();
		const result = await spawnRun({
			repos,
			burrowClient: client,
			agentName: "pi",
			projectId: "prj_xxxxxxxxxxxx",
			prompt: "run",
			warrenConfigs: {
				get: async () => ({
					triggers: null,
					defaults: { defaultProvider: "anthropic", defaultModel: "claude-opus-4-7" },
					errors: [],
				}),
				invalidate: () => undefined,
				clear: () => undefined,
				size: () => 0,
			},
		});

		const seededFm = readCanopyFrontmatter(calls);
		expect(seededFm.provider).toBe("anthropic");
		expect(seededFm.model).toBe("claude-opus-4-7");
		expect(seededFm.source).toBe("builtin");
		const stored = repos.runs.require(result.run.id).renderedAgentJson as {
			frontmatter: Record<string, unknown>;
		};
		expect(stored.frontmatter.provider).toBe("anthropic");
		expect(stored.frontmatter.model).toBe("claude-opus-4-7");
	});

	test("per-run override beats .warren/defaults.json beats agent frontmatter (warren-618b)", async () => {
		repos.agents.upsert({
			name: "pi",
			renderedJson: makeAgentJson({
				name: "pi",
				frontmatter: { provider: "pi", model: "pi-default" },
			}),
		});
		const { client } = makeBurrowClient();
		const result = await spawnRun({
			repos,
			burrowClient: client,
			agentName: "pi",
			projectId: "prj_xxxxxxxxxxxx",
			prompt: "run",
			providerOverride: "openai",
			warrenConfigs: {
				get: async () => ({
					triggers: null,
					defaults: { defaultProvider: "anthropic", defaultModel: "claude-opus-4-7" },
					errors: [],
				}),
				invalidate: () => undefined,
				clear: () => undefined,
				size: () => 0,
			},
		});
		const stored = result.run.renderedAgentJson as { frontmatter: Record<string, unknown> };
		// Operator override wins for provider; project default wins for model
		// since no per-run modelOverride was supplied.
		expect(stored.frontmatter.provider).toBe("openai");
		expect(stored.frontmatter.model).toBe("claude-opus-4-7");
	});

	test("leaves frontmatter alone when overrides are empty / whitespace (warren-f8c0)", async () => {
		repos.agents.upsert({
			name: "pi",
			renderedJson: makeAgentJson({
				name: "pi",
				frontmatter: { provider: "anthropic" },
			}),
		});
		const { client } = makeBurrowClient();
		const result = await spawnRun({
			repos,
			burrowClient: client,
			agentName: "pi",
			projectId: "prj_xxxxxxxxxxxx",
			prompt: "run",
			providerOverride: "  ",
			modelOverride: "",
		});
		const stored = result.run.renderedAgentJson as { frontmatter: Record<string, unknown> };
		expect(stored.frontmatter.provider).toBe("anthropic");
		expect(stored.frontmatter.model).toBeUndefined();
	});

	test("skips refresh when projectsConfig is not wired (back-compat for tests)", async () => {
		const { client, calls } = makeBurrowClient();
		let refreshCalled = false;
		await spawnRun({
			repos,
			burrowClient: client,
			agentName: "refactor-bot",
			projectId: "prj_xxxxxxxxxxxx",
			prompt: "p",
			refreshProjectFn: async () => {
				refreshCalled = true;
				return { project: repos.projects.require("prj_xxxxxxxxxxxx"), headSha: "x", ref: "main" };
			},
		});
		expect(refreshCalled).toBe(false);
		// Project row's lastHeadSha stays null
		expect(repos.projects.require("prj_xxxxxxxxxxxx").lastHeadSha).toBeNull();
		expect(calls.length).toBeGreaterThan(0);
	});
});

describe("composeDispatchPrompt", () => {
	test("prepends the system body with a horizontal-rule delimiter", () => {
		expect(composeDispatchPrompt("be a refactor agent", "fix it")).toBe(
			"be a refactor agent\n\n---\n\nfix it",
		);
	});

	test("trims trailing whitespace on the system body before joining", () => {
		expect(composeDispatchPrompt("system\n\n\n", "task")).toBe("system\n\n---\n\ntask");
	});

	test("returns the user prompt verbatim when system is empty or whitespace", () => {
		expect(composeDispatchPrompt("", "task")).toBe("task");
		expect(composeDispatchPrompt("   \n\t", "task")).toBe("task");
		expect(composeDispatchPrompt(undefined, "task")).toBe("task");
	});
});
