import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { BurrowClient } from "../burrow-client/index.ts";
import { ValidationError } from "../core/errors.ts";
import { openDatabase, type WarrenDb } from "../db/client.ts";
import { createRepos, type Repos } from "../db/repos/index.ts";
import { RunEventBroker } from "../runs/index.ts";
import { bearerAuth, NO_AUTH } from "./auth.ts";
import { createBridgeRegistry } from "./bridges.ts";
import { startServer } from "./server.ts";
import type { BridgeRegistry, Route, ServeHandle, ServeOptions, ServerDeps } from "./types.ts";

const silentLogger = {
	info() {},
	warn() {},
	error() {},
	debug() {},
};

function stub(
	impl: (input: URL | RequestInfo, init?: RequestInit) => Promise<Response>,
): typeof fetch {
	return impl as unknown as typeof fetch;
}

function makeBurrowClient(): BurrowClient {
	return new BurrowClient({
		config: { transport: { kind: "unix", path: "/tmp/x.sock" } },
		fetch: stub(async () => new Response(JSON.stringify({ ok: true }), { status: 200 })),
	});
}

function depsFor(repos: Repos, bridges?: BridgeRegistry): ServerDeps {
	const burrowClient = makeBurrowClient();
	const broker = new RunEventBroker();
	return {
		repos,
		burrowClient,
		broker,
		bridges:
			bridges ??
			createBridgeRegistry({
				repos,
				broker,
				burrowClient,
				bridge: async () => ({ written: 0, skipped: 0, errored: false }),
			}),
		canopyConfig: {
			repoUrl: "https://example/agents.git",
			localDir: "/tmp/cn",
			cnBinary: "cn",
			gitBinary: "git",
		},
		projectsConfig: { root: "/tmp/projects", gitBinary: "git" },
		logger: silentLogger,
		uiDistDir: null,
	};
}

function tcpOpts(extra: Partial<ServeOptions> = {}): ServeOptions {
	return {
		transport: { kind: "tcp", hostname: "127.0.0.1", port: 0 },
		auth: NO_AUTH,
		logger: silentLogger,
		...extra,
	};
}

function tcpUrl(handle: ServeHandle): string {
	if (handle.transport.kind !== "tcp") throw new Error("expected tcp transport");
	return `http://${handle.transport.hostname}:${handle.transport.port}`;
}

describe("startServer — lifecycle", () => {
	let db: WarrenDb;
	let repos: Repos;
	let handle: ServeHandle | null = null;

	beforeEach(async () => {
		db = await openDatabase({ path: ":memory:" });
		repos = createRepos(db);
	});

	afterEach(async () => {
		if (handle) {
			await handle.stop();
			handle = null;
		}
		db.close();
	});

	test("binds an ephemeral port and exposes the resolved url", () => {
		handle = startServer(depsFor(repos), tcpOpts());
		expect(handle.transport.kind).toBe("tcp");
		if (handle.transport.kind === "tcp") {
			expect(handle.transport.port).toBeGreaterThan(0);
		}
	});

	test("/healthz is auth-exempt and returns 200 ok", async () => {
		handle = startServer(depsFor(repos), tcpOpts({ auth: bearerAuth("secret") }));
		const res = await fetch(`${tcpUrl(handle)}/healthz`);
		expect(res.status).toBe(200);
		expect(((await res.json()) as { ok: boolean }).ok).toBe(true);
	});

	test("auth required for non-healthz routes", async () => {
		handle = startServer(depsFor(repos), tcpOpts({ auth: bearerAuth("secret") }));
		const res = await fetch(`${tcpUrl(handle)}/agents`);
		expect(res.status).toBe(401);
		expect(res.headers.get("www-authenticate")).toContain('Bearer realm="warren"');
	});

	test("auth accepts the matching bearer token", async () => {
		handle = startServer(depsFor(repos), tcpOpts({ auth: bearerAuth("secret") }));
		const res = await fetch(`${tcpUrl(handle)}/agents`, {
			headers: { authorization: "Bearer secret" },
		});
		expect(res.status).toBe(200);
	});

	test("unknown path → 404 not_found envelope", async () => {
		handle = startServer(depsFor(repos), tcpOpts());
		const res = await fetch(`${tcpUrl(handle)}/nope`);
		expect(res.status).toBe(404);
		const body = (await res.json()) as { error: { code: string } };
		expect(body.error.code).toBe("not_found");
	});

	test("known path with wrong method → 405 method_not_allowed", async () => {
		handle = startServer(depsFor(repos), tcpOpts());
		const res = await fetch(`${tcpUrl(handle)}/agents`, { method: "PUT" });
		expect(res.status).toBe(405);
		const body = (await res.json()) as { error: { code: string } };
		expect(body.error.code).toBe("method_not_allowed");
	});

	test("handler that throws WarrenError → mapped status + envelope", async () => {
		const routes: Route[] = [
			{
				method: "GET",
				pattern: "/boom",
				handler: () => {
					throw new ValidationError("nope", { recoveryHint: "fix it" });
				},
			},
		];
		handle = startServer(depsFor(repos), tcpOpts({ routes }));
		const res = await fetch(`${tcpUrl(handle)}/boom`);
		expect(res.status).toBe(400);
		const body = (await res.json()) as { error: { code: string; hint?: string } };
		expect(body.error.code).toBe("validation_error");
		expect(body.error.hint).toBe("fix it");
	});

	test("handler that throws plain Error → 500 internal_error", async () => {
		const routes: Route[] = [
			{
				method: "GET",
				pattern: "/boom",
				handler: () => {
					throw new Error("kaboom");
				},
			},
		];
		handle = startServer(depsFor(repos), tcpOpts({ routes }));
		const res = await fetch(`${tcpUrl(handle)}/boom`);
		expect(res.status).toBe(500);
	});
});

describe("startServer — routes", () => {
	let db: WarrenDb;
	let repos: Repos;
	let handle: ServeHandle | null = null;

	beforeEach(async () => {
		db = await openDatabase({ path: ":memory:" });
		repos = createRepos(db);
		repos.agents.upsert({
			name: "refactor-bot",
			renderedJson: { name: "refactor-bot", sections: { system: "x" } },
		});
	});

	afterEach(async () => {
		if (handle) {
			await handle.stop();
			handle = null;
		}
		db.close();
	});

	test("GET /agents returns the agents list", async () => {
		handle = startServer(depsFor(repos), tcpOpts());
		const res = await fetch(`${tcpUrl(handle)}/agents`);
		expect(res.status).toBe(200);
		const body = (await res.json()) as { agents: Array<{ name: string }> };
		expect(body.agents.length).toBe(1);
		expect(body.agents[0]?.name).toBe("refactor-bot");
	});

	test("GET /agents/:name returns the agent or 404", async () => {
		handle = startServer(depsFor(repos), tcpOpts());

		const ok = await fetch(`${tcpUrl(handle)}/agents/refactor-bot`);
		expect(ok.status).toBe(200);

		const missing = await fetch(`${tcpUrl(handle)}/agents/missing-bot`);
		expect(missing.status).toBe(404);
	});

	test("GET /projects returns the (empty) projects list", async () => {
		handle = startServer(depsFor(repos), tcpOpts());
		const res = await fetch(`${tcpUrl(handle)}/projects`);
		expect(res.status).toBe(200);
		const body = (await res.json()) as { projects: unknown[] };
		expect(body.projects).toEqual([]);
	});

	test("GET /runs returns the empty runs list", async () => {
		handle = startServer(depsFor(repos), tcpOpts());
		const res = await fetch(`${tcpUrl(handle)}/runs`);
		expect(res.status).toBe(200);
	});

	test("GET /runs/:id 404s on unknown id", async () => {
		handle = startServer(depsFor(repos), tcpOpts());
		const res = await fetch(`${tcpUrl(handle)}/runs/run_unknown`);
		expect(res.status).toBe(404);
	});

	test("/readyz returns 503 when burrow probe fails or no agents", async () => {
		// Empty agents — readyz should be 503.
		const dbEmpty = await openDatabase({ path: ":memory:" });
		const reposEmpty = createRepos(dbEmpty);
		try {
			handle = startServer(depsFor(reposEmpty), tcpOpts());
			const res = await fetch(`${tcpUrl(handle)}/readyz`);
			expect(res.status).toBe(503);
			const body = (await res.json()) as { ok: boolean; checks: { name: string; ok: boolean }[] };
			expect(body.ok).toBe(false);
			expect(body.checks.find((c) => c.name === "agents")?.ok).toBe(false);
		} finally {
			await handle?.stop();
			handle = null;
			dbEmpty.close();
		}
	});
});
