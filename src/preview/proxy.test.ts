import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { LOCAL_WORKER_NAME } from "../burrow-client/pool.ts";
import { openDatabase, type WarrenDb } from "../db/client.ts";
import { createRepos, type Repos } from "../db/repos/index.ts";
import { COOKIE_NAME, createPreviewAuth, type PreviewAuth } from "./cookie.ts";
import {
	createPreviewProxyHandler,
	HTML_HEAD_LOOKAHEAD_BYTES,
	injectBaseHref,
	isHtmlContentType,
	parsePreviewPathPrefix,
	parseRunIdFromHost,
	rewriteLocationHeader,
} from "./proxy.ts";

function fetchStub(
	impl: (input: URL | RequestInfo, init?: RequestInit) => Promise<Response>,
): typeof fetch {
	return impl as unknown as typeof fetch;
}

const TOKEN = "test-token-very-secret-1234567890abcdef";
const HOST = "preview.warren.example.com";

describe("parseRunIdFromHost", () => {
	test("matches `run-<id>.<host>`", () => {
		expect(parseRunIdFromHost("run-abc.preview.warren.example.com", HOST)).toBe("abc");
		expect(parseRunIdFromHost("run-run_abc123.preview.warren.example.com", HOST)).toBe(
			"run_abc123",
		);
	});

	test("tolerates an optional port suffix on the Host header", () => {
		expect(parseRunIdFromHost("run-abc.preview.warren.example.com:8080", HOST)).toBe("abc");
	});

	test("rejects the bare warren host", () => {
		expect(parseRunIdFromHost("preview.warren.example.com", HOST)).toBeNull();
	});

	test("rejects deeper labels (security: no nested-subdomain spoofing)", () => {
		expect(parseRunIdFromHost("foo.run-abc.preview.warren.example.com", HOST)).toBeNull();
	});

	test("rejects non-`run-` prefix", () => {
		expect(parseRunIdFromHost("abc.preview.warren.example.com", HOST)).toBeNull();
	});

	test("rejects null + empty", () => {
		expect(parseRunIdFromHost(null, HOST)).toBeNull();
		expect(parseRunIdFromHost("", HOST)).toBeNull();
	});
});

describe("parsePreviewPathPrefix", () => {
	test("matches `/p/<runId>/<rest>`", () => {
		const r = parsePreviewPathPrefix("/p/run_abc/foo/bar");
		expect(r).toEqual({ runId: "run_abc", rest: "/foo/bar" });
	});

	test("matches `/p/<runId>/` with trailing slash and empty rest → `/`", () => {
		const r = parsePreviewPathPrefix("/p/run_abc/");
		expect(r).toEqual({ runId: "run_abc", rest: "/" });
	});

	test("matches `/p/<runId>` (no trailing slash) and defaults rest to `/`", () => {
		const r = parsePreviewPathPrefix("/p/run_abc");
		expect(r).toEqual({ runId: "run_abc", rest: "/" });
	});

	test("returns null for non-preview paths", () => {
		expect(parsePreviewPathPrefix("/")).toBeNull();
		expect(parsePreviewPathPrefix("/runs/run_abc")).toBeNull();
		expect(parsePreviewPathPrefix("/p")).toBeNull();
		expect(parsePreviewPathPrefix("/p/")).toBeNull();
		expect(parsePreviewPathPrefix("/projects")).toBeNull();
	});

	test("rejects path-traversal in the runId segment", () => {
		// `.` and `/` are not in the charset; a path-traversal attempt
		// either gets eaten by URL normalization upstream or returns null
		// here. The 'rest' segment can contain anything — it's just the
		// upstream URL path.
		expect(parsePreviewPathPrefix("/p/../etc/passwd")).toBeNull();
		expect(parsePreviewPathPrefix("/p/run.abc/foo")).toBeNull();
	});

	test("rest preserves query separator boundary (called with pathname only)", () => {
		// parsePreviewPathPrefix takes a pathname, not a full URL — the
		// proxy handler keeps `url.search` separately and re-attaches it
		// at forward time. So no `?` shows up in a real call.
		const r = parsePreviewPathPrefix("/p/run_abc/api/v1/list");
		expect(r).toEqual({ runId: "run_abc", rest: "/api/v1/list" });
	});
});

describe("createPreviewProxyHandler (subdomain mode)", () => {
	let db: WarrenDb;
	let repos: Repos;
	let auth: PreviewAuth;
	let runId: string;
	let projectId: string;

	beforeEach(async () => {
		db = await openDatabase({ path: ":memory:" });
		repos = createRepos(db);
		auth = createPreviewAuth(TOKEN, { secure: false });
		await repos.agents.upsert({ name: "agent", renderedJson: { sections: {} } });
		const project = await repos.projects.create({
			gitUrl: "https://github.com/x/y.git",
			localPath: "/data/projects/x/y",
			defaultBranch: "main",
		});
		projectId = project.id;
		const run = await repos.runs.create({
			agentName: "agent",
			projectId,
			prompt: "p",
			renderedAgentJson: {},
			trigger: "manual",
			burrowId: "bur_x",
			workerId: LOCAL_WORKER_NAME,
		});
		runId = run.id;
		await repos.runs.attachPreview(runId, {
			previewState: "live",
			previewPort: 30100,
			previewStartedAt: "2026-01-01T00:00:00Z",
			previewLastHitAt: "2026-01-01T00:00:00Z",
		});
	});

	afterEach(async () => {
		await db.close();
	});

	function buildRequest(opts: {
		host: string;
		path?: string;
		cookie?: string | null;
		method?: string;
		extraHeaders?: Record<string, string>;
	}): { request: Request; url: URL } {
		const path = opts.path ?? "/";
		const headers: Record<string, string> = {
			host: opts.host,
			...(opts.extraHeaders ?? {}),
		};
		if (opts.cookie !== undefined && opts.cookie !== null) headers.cookie = opts.cookie;
		const request = new Request(`http://${opts.host}${path}`, {
			method: opts.method ?? "GET",
			headers,
		});
		const url = new URL(request.url);
		return { request, url };
	}

	function validCookieFor(thisRunId: string, now: Date): string {
		const c = auth.signCookie(thisRunId, now);
		return `${COOKIE_NAME}=${c.value}`;
	}

	test("returns null for hosts that don't match the preview suffix", async () => {
		const handler = createPreviewProxyHandler({
			repos,
			previewAuth: auth,
			config: { mode: "subdomain", host: HOST },
			fetch: fetchStub(async () => new Response("nope")),
		});
		const { request, url } = buildRequest({ host: "warren.example.com" });
		expect(await handler(request, url)).toBeNull();
	});

	test("404 for unknown runId", async () => {
		const handler = createPreviewProxyHandler({
			repos,
			previewAuth: auth,
			config: { mode: "subdomain", host: HOST },
			fetch: fetchStub(async () => new Response("nope")),
		});
		const { request, url } = buildRequest({ host: `run-doesnotexist.${HOST}` });
		const res = await handler(request, url);
		expect(res?.status).toBe(404);
	});

	test("501 cross-host (worker_id !== local) with R-12 deferral message", async () => {
		await repos.runs.attachBurrow(runId, { workerId: "remote-worker-2" });
		const handler = createPreviewProxyHandler({
			repos,
			previewAuth: auth,
			config: { mode: "subdomain", host: HOST },
			fetch: fetchStub(async () => new Response("nope")),
		});
		const { request, url } = buildRequest({ host: `run-${runId}.${HOST}` });
		const res = await handler(request, url);
		expect(res?.status).toBe(501);
		const body = (await res?.json()) as { error: { code: string; message: string } };
		expect(body.error.code).toBe("preview_remote_worker");
		expect(body.error.message).toContain("R-12");
	});

	test("503 when preview_state is not live", async () => {
		await repos.runs.attachPreview(runId, { previewState: "starting" });
		const handler = createPreviewProxyHandler({
			repos,
			previewAuth: auth,
			config: { mode: "subdomain", host: HOST },
			fetch: fetchStub(async () => new Response("nope")),
		});
		const { request, url } = buildRequest({
			host: `run-${runId}.${HOST}`,
			cookie: validCookieFor(runId, new Date()),
		});
		const res = await handler(request, url);
		expect(res?.status).toBe(503);
	});

	test("401 when cookie is missing — never 200, never 502 (SPEC §11.L risk #2)", async () => {
		let upstreamCalled = false;
		const handler = createPreviewProxyHandler({
			repos,
			previewAuth: auth,
			config: { mode: "subdomain", host: HOST },
			fetch: fetchStub(async () => {
				upstreamCalled = true;
				return new Response("upstream");
			}),
		});
		const { request, url } = buildRequest({ host: `run-${runId}.${HOST}` });
		const res = await handler(request, url);
		expect(res?.status).toBe(401);
		expect(upstreamCalled).toBe(false);
		const body = (await res?.json()) as { error: { code: string } };
		expect(body.error.code).toBe("preview_unauthorized");
	});

	test("401 when cookie is for a different run", async () => {
		const handler = createPreviewProxyHandler({
			repos,
			previewAuth: auth,
			config: { mode: "subdomain", host: HOST },
			fetch: fetchStub(async () => new Response("upstream")),
		});
		const { request, url } = buildRequest({
			host: `run-${runId}.${HOST}`,
			cookie: validCookieFor("run_other", new Date()),
		});
		const res = await handler(request, url);
		expect(res?.status).toBe(401);
	});

	test("forwards a valid request to 127.0.0.1:<port>", async () => {
		const captured: { url: string | undefined; method: string | undefined; host: string | null } = {
			url: undefined,
			method: undefined,
			host: null,
		};
		const handler = createPreviewProxyHandler({
			repos,
			previewAuth: auth,
			config: { mode: "subdomain", host: HOST },
			fetch: fetchStub(async (input, init) => {
				captured.url = typeof input === "string" ? input : (input as Request).url;
				captured.method = init?.method;
				captured.host = (init?.headers as Headers).get("host");
				return new Response("ok-from-upstream", { status: 200 });
			}),
		});
		const { request, url } = buildRequest({
			host: `run-${runId}.${HOST}`,
			path: "/some/page?q=1",
			cookie: validCookieFor(runId, new Date()),
		});
		const res = await handler(request, url);
		expect(res?.status).toBe(200);
		expect(await res?.text()).toBe("ok-from-upstream");
		expect(captured.url).toBe("http://127.0.0.1:30100/some/page?q=1");
		expect(captured.method).toBe("GET");
		expect(captured.host).toBe("127.0.0.1:30100");
	});

	test("strips Authorization + warren_preview cookie before forwarding", async () => {
		let forwardedAuth: string | null = "unset";
		let forwardedCookie: string | null = "unset";
		const handler = createPreviewProxyHandler({
			repos,
			previewAuth: auth,
			config: { mode: "subdomain", host: HOST },
			fetch: fetchStub(async (_input, init) => {
				const headers = init?.headers as Headers;
				forwardedAuth = headers.get("authorization");
				forwardedCookie = headers.get("cookie");
				return new Response("ok");
			}),
		});
		const { request, url } = buildRequest({
			host: `run-${runId}.${HOST}`,
			cookie: `${validCookieFor(runId, new Date())}; other=keepme`,
			extraHeaders: { authorization: "Bearer leaky-token" },
		});
		await handler(request, url);
		expect(forwardedAuth).toBeNull();
		expect(forwardedCookie).toBeNull();
	});

	test("updates preview_last_hit_at BEFORE returning, debounced", async () => {
		let now = new Date("2026-01-01T01:00:00Z");
		const handler = createPreviewProxyHandler({
			repos,
			previewAuth: auth,
			config: { mode: "subdomain", host: HOST, lastHitDebounceMs: 30_000 },
			now: () => now,
			fetch: fetchStub(async () => new Response("ok")),
		});

		// Reset preview_last_hit_at well in the past so the first call writes.
		await repos.runs.attachPreview(runId, { previewLastHitAt: "2025-12-01T00:00:00Z" });

		const cookie = validCookieFor(runId, now);
		const first = buildRequest({ host: `run-${runId}.${HOST}`, cookie });
		const r1 = await handler(first.request, first.url);
		expect(r1?.status).toBe(200);
		const after1 = await repos.runs.require(runId);
		expect(after1.previewLastHitAt).toBe(now.toISOString());

		// Within the debounce window: last_hit_at must NOT be re-written.
		const before2 = after1.previewLastHitAt;
		now = new Date(now.getTime() + 5_000);
		const second = buildRequest({ host: `run-${runId}.${HOST}`, cookie });
		await handler(second.request, second.url);
		const after2 = await repos.runs.require(runId);
		expect(after2.previewLastHitAt).toBe(before2);

		// Past the debounce window: writes again.
		now = new Date(now.getTime() + 30_001);
		const third = buildRequest({ host: `run-${runId}.${HOST}`, cookie });
		await handler(third.request, third.url);
		const after3 = await repos.runs.require(runId);
		expect(after3.previewLastHitAt).toBe(now.toISOString());
	});

	test("WebSocket upgrade returns 426 (HTTP-only V1)", async () => {
		const handler = createPreviewProxyHandler({
			repos,
			previewAuth: auth,
			config: { mode: "subdomain", host: HOST },
			fetch: fetchStub(async () => new Response("nope")),
		});
		const { request, url } = buildRequest({
			host: `run-${runId}.${HOST}`,
			cookie: validCookieFor(runId, new Date()),
			extraHeaders: { upgrade: "websocket" },
		});
		const res = await handler(request, url);
		expect(res?.status).toBe(426);
	});

	test("502 when upstream fetch throws", async () => {
		const handler = createPreviewProxyHandler({
			repos,
			previewAuth: auth,
			config: { mode: "subdomain", host: HOST },
			fetch: fetchStub(async () => {
				throw new Error("ECONNREFUSED");
			}),
		});
		const { request, url } = buildRequest({
			host: `run-${runId}.${HOST}`,
			cookie: validCookieFor(runId, new Date()),
		});
		const res = await handler(request, url);
		expect(res?.status).toBe(502);
	});
});

describe("createPreviewProxyHandler (path mode)", () => {
	let db: WarrenDb;
	let repos: Repos;
	let auth: PreviewAuth;
	let runId: string;
	let projectId: string;

	beforeEach(async () => {
		db = await openDatabase({ path: ":memory:" });
		repos = createRepos(db);
		// Path mode runs against the warren origin: no Domain attribute
		// on the cookie (warren-edff narrows scope to Path=/p/<id>/ in
		// the next step; this step still HMAC-verifies against runId).
		auth = createPreviewAuth(TOKEN, { secure: false, cookieDomain: null });
		await repos.agents.upsert({ name: "agent", renderedJson: { sections: {} } });
		const project = await repos.projects.create({
			gitUrl: "https://github.com/x/y.git",
			localPath: "/data/projects/x/y",
			defaultBranch: "main",
		});
		projectId = project.id;
		const run = await repos.runs.create({
			agentName: "agent",
			projectId,
			prompt: "p",
			renderedAgentJson: {},
			trigger: "manual",
			burrowId: "bur_x",
			workerId: LOCAL_WORKER_NAME,
		});
		runId = run.id;
		await repos.runs.attachPreview(runId, {
			previewState: "live",
			previewPort: 30200,
			previewStartedAt: "2026-01-01T00:00:00Z",
			previewLastHitAt: "2026-01-01T00:00:00Z",
		});
	});

	afterEach(async () => {
		await db.close();
	});

	function buildPathRequest(opts: {
		path: string;
		cookie?: string | null;
		method?: string;
		extraHeaders?: Record<string, string>;
	}): { request: Request; url: URL } {
		const headers: Record<string, string> = {
			host: "warren.example.com",
			...(opts.extraHeaders ?? {}),
		};
		if (opts.cookie !== undefined && opts.cookie !== null) headers.cookie = opts.cookie;
		const request = new Request(`http://warren.example.com${opts.path}`, {
			method: opts.method ?? "GET",
			headers,
		});
		const url = new URL(request.url);
		return { request, url };
	}

	function validCookieFor(thisRunId: string, now: Date): string {
		const c = auth.signCookie(thisRunId, now);
		return `${COOKIE_NAME}=${c.value}`;
	}

	test("returns null for paths that don't start with /p/<id>", async () => {
		const handler = createPreviewProxyHandler({
			repos,
			previewAuth: auth,
			config: { mode: "path" },
			fetch: fetchStub(async () => new Response("nope")),
		});
		const cases = ["/", "/runs/abc", "/p", "/p/", "/projects/list"];
		for (const path of cases) {
			const { request, url } = buildPathRequest({ path });
			expect(await handler(request, url)).toBeNull();
		}
	});

	test("subdomain-shaped Host on a non-preview path returns null in path mode", async () => {
		// In path mode the Host header is irrelevant — only the path
		// matters. A request to /runs/foo with a run-x.<host> Host
		// must fall through to the normal pipeline.
		const handler = createPreviewProxyHandler({
			repos,
			previewAuth: auth,
			config: { mode: "path" },
			fetch: fetchStub(async () => new Response("nope")),
		});
		const request = new Request(`http://run-${runId}.preview.warren.example.com/runs/x`, {
			headers: { host: `run-${runId}.preview.warren.example.com` },
		});
		const url = new URL(request.url);
		expect(await handler(request, url)).toBeNull();
	});

	test("404 for unknown runId in /p/<unknown>/", async () => {
		const handler = createPreviewProxyHandler({
			repos,
			previewAuth: auth,
			config: { mode: "path" },
			fetch: fetchStub(async () => new Response("nope")),
		});
		const { request, url } = buildPathRequest({ path: "/p/run_doesnotexist/" });
		const res = await handler(request, url);
		expect(res?.status).toBe(404);
	});

	test("501 cross-host (worker_id !== local) with R-12 deferral message", async () => {
		await repos.runs.attachBurrow(runId, { workerId: "remote-worker-2" });
		const handler = createPreviewProxyHandler({
			repos,
			previewAuth: auth,
			config: { mode: "path" },
			fetch: fetchStub(async () => new Response("nope")),
		});
		const { request, url } = buildPathRequest({ path: `/p/${runId}/` });
		const res = await handler(request, url);
		expect(res?.status).toBe(501);
		const body = (await res?.json()) as { error: { code: string; message: string } };
		expect(body.error.code).toBe("preview_remote_worker");
		expect(body.error.message).toContain("R-12");
	});

	test("503 when preview_state is not live", async () => {
		await repos.runs.attachPreview(runId, { previewState: "starting" });
		const handler = createPreviewProxyHandler({
			repos,
			previewAuth: auth,
			config: { mode: "path" },
			fetch: fetchStub(async () => new Response("nope")),
		});
		const { request, url } = buildPathRequest({
			path: `/p/${runId}/`,
			cookie: validCookieFor(runId, new Date()),
		});
		const res = await handler(request, url);
		expect(res?.status).toBe(503);
	});

	test("401 when cookie is missing — never 200, never 502", async () => {
		let upstreamCalled = false;
		const handler = createPreviewProxyHandler({
			repos,
			previewAuth: auth,
			config: { mode: "path" },
			fetch: fetchStub(async () => {
				upstreamCalled = true;
				return new Response("upstream");
			}),
		});
		const { request, url } = buildPathRequest({ path: `/p/${runId}/` });
		const res = await handler(request, url);
		expect(res?.status).toBe(401);
		expect(upstreamCalled).toBe(false);
		const body = (await res?.json()) as { error: { code: string; hint: string } };
		expect(body.error.code).toBe("preview_unauthorized");
		// Path-mode hint points at the warren origin from the request.
		expect(body.error.hint).toContain(`/runs/${runId}/preview/login`);
		expect(body.error.hint).toContain(`/p/${runId}/`);
	});

	test("401 when cookie is for a different run", async () => {
		const handler = createPreviewProxyHandler({
			repos,
			previewAuth: auth,
			config: { mode: "path" },
			fetch: fetchStub(async () => new Response("upstream")),
		});
		const { request, url } = buildPathRequest({
			path: `/p/${runId}/`,
			cookie: validCookieFor("run_other", new Date()),
		});
		const res = await handler(request, url);
		expect(res?.status).toBe(401);
	});

	test("forwards `/p/<id>/foo?q=1` → upstream `/foo?q=1` (prefix stripped)", async () => {
		const captured: { url: string | undefined; host: string | null } = {
			url: undefined,
			host: null,
		};
		const handler = createPreviewProxyHandler({
			repos,
			previewAuth: auth,
			config: { mode: "path" },
			fetch: fetchStub(async (input, init) => {
				captured.url = typeof input === "string" ? input : (input as Request).url;
				captured.host = (init?.headers as Headers).get("host");
				return new Response("ok-from-upstream", { status: 200 });
			}),
		});
		const { request, url } = buildPathRequest({
			path: `/p/${runId}/foo?q=1`,
			cookie: validCookieFor(runId, new Date()),
		});
		const res = await handler(request, url);
		expect(res?.status).toBe(200);
		expect(await res?.text()).toBe("ok-from-upstream");
		expect(captured.url).toBe("http://127.0.0.1:30200/foo?q=1");
		expect(captured.host).toBe("127.0.0.1:30200");
	});

	test("forwards `/p/<id>/` (root) → upstream `/`", async () => {
		let upstreamUrl: string | undefined;
		const handler = createPreviewProxyHandler({
			repos,
			previewAuth: auth,
			config: { mode: "path" },
			fetch: fetchStub(async (input) => {
				upstreamUrl = typeof input === "string" ? input : (input as Request).url;
				return new Response("ok", { status: 200 });
			}),
		});
		const { request, url } = buildPathRequest({
			path: `/p/${runId}/`,
			cookie: validCookieFor(runId, new Date()),
		});
		await handler(request, url);
		expect(upstreamUrl).toBe("http://127.0.0.1:30200/");
	});

	test("forwards `/p/<id>` (no trailing slash) → upstream `/`", async () => {
		let upstreamUrl: string | undefined;
		const handler = createPreviewProxyHandler({
			repos,
			previewAuth: auth,
			config: { mode: "path" },
			fetch: fetchStub(async (input) => {
				upstreamUrl = typeof input === "string" ? input : (input as Request).url;
				return new Response("ok", { status: 200 });
			}),
		});
		const { request, url } = buildPathRequest({
			path: `/p/${runId}`,
			cookie: validCookieFor(runId, new Date()),
		});
		await handler(request, url);
		expect(upstreamUrl).toBe("http://127.0.0.1:30200/");
	});

	test("strips Authorization + warren_preview cookie before forwarding", async () => {
		let forwardedAuth: string | null = "unset";
		let forwardedCookie: string | null = "unset";
		const handler = createPreviewProxyHandler({
			repos,
			previewAuth: auth,
			config: { mode: "path" },
			fetch: fetchStub(async (_input, init) => {
				const headers = init?.headers as Headers;
				forwardedAuth = headers.get("authorization");
				forwardedCookie = headers.get("cookie");
				return new Response("ok");
			}),
		});
		const { request, url } = buildPathRequest({
			path: `/p/${runId}/`,
			cookie: `${validCookieFor(runId, new Date())}; other=keepme`,
			extraHeaders: { authorization: "Bearer leaky-token" },
		});
		await handler(request, url);
		expect(forwardedAuth).toBeNull();
		expect(forwardedCookie).toBeNull();
	});

	test("updates preview_last_hit_at BEFORE returning, debounced", async () => {
		let now = new Date("2026-01-01T01:00:00Z");
		const handler = createPreviewProxyHandler({
			repos,
			previewAuth: auth,
			config: { mode: "path", lastHitDebounceMs: 30_000 },
			now: () => now,
			fetch: fetchStub(async () => new Response("ok")),
		});
		await repos.runs.attachPreview(runId, { previewLastHitAt: "2025-12-01T00:00:00Z" });
		const cookie = validCookieFor(runId, now);
		const first = buildPathRequest({ path: `/p/${runId}/`, cookie });
		await handler(first.request, first.url);
		const after1 = await repos.runs.require(runId);
		expect(after1.previewLastHitAt).toBe(now.toISOString());

		// Within debounce: no write.
		const before2 = after1.previewLastHitAt;
		now = new Date(now.getTime() + 5_000);
		const second = buildPathRequest({ path: `/p/${runId}/`, cookie });
		await handler(second.request, second.url);
		const after2 = await repos.runs.require(runId);
		expect(after2.previewLastHitAt).toBe(before2);
	});

	test("WebSocket upgrade returns 426", async () => {
		const handler = createPreviewProxyHandler({
			repos,
			previewAuth: auth,
			config: { mode: "path" },
			fetch: fetchStub(async () => new Response("nope")),
		});
		const { request, url } = buildPathRequest({
			path: `/p/${runId}/`,
			cookie: validCookieFor(runId, new Date()),
			extraHeaders: { upgrade: "websocket" },
		});
		const res = await handler(request, url);
		expect(res?.status).toBe(426);
	});

	test("502 when upstream fetch throws", async () => {
		const handler = createPreviewProxyHandler({
			repos,
			previewAuth: auth,
			config: { mode: "path" },
			fetch: fetchStub(async () => {
				throw new Error("ECONNREFUSED");
			}),
		});
		const { request, url } = buildPathRequest({
			path: `/p/${runId}/`,
			cookie: validCookieFor(runId, new Date()),
		});
		const res = await handler(request, url);
		expect(res?.status).toBe(502);
	});
});

describe("isHtmlContentType", () => {
	test("matches bare text/html", () => {
		expect(isHtmlContentType("text/html")).toBe(true);
	});

	test("matches text/html with charset parameter", () => {
		expect(isHtmlContentType("text/html; charset=utf-8")).toBe(true);
		expect(isHtmlContentType("text/html;charset=UTF-8")).toBe(true);
		expect(isHtmlContentType("TEXT/HTML")).toBe(true);
	});

	test("rejects other content types", () => {
		expect(isHtmlContentType("application/json")).toBe(false);
		expect(isHtmlContentType("application/xhtml+xml")).toBe(false);
		expect(isHtmlContentType("text/plain")).toBe(false);
		expect(isHtmlContentType("text/css")).toBe(false);
		expect(isHtmlContentType("application/javascript")).toBe(false);
	});

	test("rejects null", () => {
		expect(isHtmlContentType(null)).toBe(false);
	});
});

describe("rewriteLocationHeader", () => {
	const PREFIX = "/p/run_abc";

	test("prefixes a same-origin absolute path", () => {
		expect(rewriteLocationHeader("/signin", PREFIX)).toBe("/p/run_abc/signin");
		expect(rewriteLocationHeader("/", PREFIX)).toBe("/p/run_abc/");
		expect(rewriteLocationHeader("/api/v1/list?x=1", PREFIX)).toBe("/p/run_abc/api/v1/list?x=1");
	});

	test("leaves an absolute URL untouched", () => {
		expect(rewriteLocationHeader("https://example.com/foo", PREFIX)).toBe(
			"https://example.com/foo",
		);
		expect(rewriteLocationHeader("http://other/path", PREFIX)).toBe("http://other/path");
	});

	test("leaves a scheme-relative URL untouched", () => {
		expect(rewriteLocationHeader("//cdn.example.com/asset.js", PREFIX)).toBe(
			"//cdn.example.com/asset.js",
		);
	});

	test("does not double-prefix a value already under the path prefix", () => {
		expect(rewriteLocationHeader("/p/run_abc/", PREFIX)).toBe("/p/run_abc/");
		expect(rewriteLocationHeader("/p/run_abc/foo", PREFIX)).toBe("/p/run_abc/foo");
		expect(rewriteLocationHeader("/p/run_abc", PREFIX)).toBe("/p/run_abc");
	});

	test("does prefix a path that incidentally starts with a different /p/ run id", () => {
		// `/p/run_other/foo` is a different run's prefix; from this run's
		// proxy view it's just an opaque absolute path that should escape
		// into `/p/<this-run>/p/run_other/foo`. The 404 from the upstream is
		// the safer failure than smuggling a request into the sibling run.
		expect(rewriteLocationHeader("/p/run_other/foo", PREFIX)).toBe("/p/run_abc/p/run_other/foo");
	});

	test("leaves empty string untouched", () => {
		expect(rewriteLocationHeader("", PREFIX)).toBe("");
	});

	test("leaves non-absolute paths untouched (relative or fragment)", () => {
		// Per SPEC §11.L only same-origin absolute paths (start with `/`)
		// are rewritten. Relative / fragment values stay verbatim.
		expect(rewriteLocationHeader("foo/bar", PREFIX)).toBe("foo/bar");
		expect(rewriteLocationHeader("#anchor", PREFIX)).toBe("#anchor");
	});
});

describe("injectBaseHref", () => {
	const PREFIX = "/p/run_abc";
	const enc = new TextEncoder();
	const dec = new TextDecoder();

	function inject(html: string): string {
		const out = injectBaseHref(enc.encode(html), PREFIX);
		if (out === null) throw new Error("expected injectBaseHref to rewrite, got null");
		return dec.decode(out);
	}

	test("injects <base> immediately after the opening <head> tag", () => {
		expect(inject("<!doctype html><html><head><title>x</title></head><body>y</body></html>")).toBe(
			'<!doctype html><html><head><base href="/p/run_abc/"><title>x</title></head><body>y</body></html>',
		);
	});

	test("tolerates attributes on the <head> tag", () => {
		expect(inject('<html><head lang="en" dir="ltr"><title>x</title></head></html>')).toBe(
			'<html><head lang="en" dir="ltr"><base href="/p/run_abc/"><title>x</title></head></html>',
		);
	});

	test("is case-insensitive on the head tag", () => {
		expect(inject("<HTML><HEAD><TITLE>x</TITLE></HEAD></HTML>")).toBe(
			'<HTML><HEAD><base href="/p/run_abc/"><TITLE>x</TITLE></HEAD></HTML>',
		);
	});

	test("returns null (no-op) when a <base> element is already present", () => {
		const html = '<html><head><base href="/whatever/"><title>x</title></head></html>';
		expect(injectBaseHref(enc.encode(html), PREFIX)).toBeNull();
	});

	test("returns null (no-op) when the document already has the path-mode <base>", () => {
		// Re-proxying a warren-served document must be idempotent.
		const html = '<html><head><base href="/p/run_abc/"></head></html>';
		expect(injectBaseHref(enc.encode(html), PREFIX)).toBeNull();
	});

	test("recognizes self-closing <base /> as already present", () => {
		const html = '<html><head><base href="/x/" /></head></html>';
		expect(injectBaseHref(enc.encode(html), PREFIX)).toBeNull();
	});

	test("returns null when there is no <head> in the lookahead window", () => {
		const html = "<html><body>no head here</body></html>";
		expect(injectBaseHref(enc.encode(html), PREFIX)).toBeNull();
	});

	test("does not match <basefont> as a <base> element", () => {
		// Deprecated tag — but if the upstream uses it, we still want to
		// inject our own <base>.
		expect(inject("<html><head><basefont color=red><title>x</title></head></html>")).toContain(
			'<head><base href="/p/run_abc/"><basefont',
		);
	});

	test("does nothing when <head> sits beyond the 64 KiB lookahead window", () => {
		// Pad with a giant HTML comment so the <head> tag is past the
		// lookahead bound.
		const pad = "x".repeat(HTML_HEAD_LOOKAHEAD_BYTES);
		const html = `<!--${pad}--><html><head></head></html>`;
		expect(injectBaseHref(enc.encode(html), PREFIX)).toBeNull();
	});

	test("preserves arbitrary UTF-8 bytes in the body verbatim", () => {
		expect(inject("<html><head></head><body>héllo 🌳 こんにちは</body></html>")).toBe(
			'<html><head><base href="/p/run_abc/"></head><body>héllo 🌳 こんにちは</body></html>',
		);
	});
});

describe("createPreviewProxyHandler (path mode) — HTML rewrites (warren-ab3a)", () => {
	let db: WarrenDb;
	let repos: Repos;
	let auth: PreviewAuth;
	let runId: string;
	let projectId: string;

	beforeEach(async () => {
		db = await openDatabase({ path: ":memory:" });
		repos = createRepos(db);
		auth = createPreviewAuth(TOKEN, { secure: false, cookieDomain: null });
		await repos.agents.upsert({ name: "agent", renderedJson: { sections: {} } });
		const project = await repos.projects.create({
			gitUrl: "https://github.com/x/y.git",
			localPath: "/data/projects/x/y",
			defaultBranch: "main",
		});
		projectId = project.id;
		const run = await repos.runs.create({
			agentName: "agent",
			projectId,
			prompt: "p",
			renderedAgentJson: {},
			trigger: "manual",
			burrowId: "bur_x",
			workerId: LOCAL_WORKER_NAME,
		});
		runId = run.id;
		await repos.runs.attachPreview(runId, {
			previewState: "live",
			previewPort: 30200,
			previewStartedAt: "2026-01-01T00:00:00Z",
			previewLastHitAt: "2026-01-01T00:00:00Z",
		});
	});

	afterEach(async () => {
		await db.close();
	});

	function pathHandler(upstreamFetch: typeof fetch) {
		return createPreviewProxyHandler({
			repos,
			previewAuth: auth,
			config: { mode: "path" },
			fetch: upstreamFetch,
		});
	}

	function buildPathRequest(path: string): { request: Request; url: URL } {
		const c = auth.signCookie(runId, new Date());
		const request = new Request(`http://warren.example.com${path}`, {
			headers: {
				host: "warren.example.com",
				cookie: `${COOKIE_NAME}=${c.value}`,
			},
		});
		return { request, url: new URL(request.url) };
	}

	test("injects <base href> into a text/html response", async () => {
		const handler = pathHandler(
			fetchStub(
				async () =>
					new Response("<html><head><title>x</title></head><body>ok</body></html>", {
						status: 200,
						headers: { "content-type": "text/html; charset=utf-8" },
					}),
			),
		);
		const { request, url } = buildPathRequest(`/p/${runId}/`);
		const res = await handler(request, url);
		expect(res?.status).toBe(200);
		const body = await res?.text();
		expect(body).toBe(
			`<html><head><base href="/p/${runId}/"><title>x</title></head><body>ok</body></html>`,
		);
		// content-length is stripped so the consumer doesn't honor a stale value.
		expect(res?.headers.get("content-length")).toBeNull();
	});

	test("leaves a non-HTML response (JSON) byte-for-byte", async () => {
		const handler = pathHandler(
			fetchStub(
				async () =>
					new Response('{"hello":"/world"}', {
						status: 200,
						headers: { "content-type": "application/json" },
					}),
			),
		);
		const { request, url } = buildPathRequest(`/p/${runId}/api/x`);
		const res = await handler(request, url);
		expect(await res?.text()).toBe('{"hello":"/world"}');
	});

	test("leaves CSS / JS / images alone", async () => {
		const cases = ["text/css", "application/javascript", "image/png"];
		for (const ct of cases) {
			const handler = pathHandler(
				fetchStub(
					async () =>
						new Response("/* :root { } */ /not/rewritten", {
							status: 200,
							headers: { "content-type": ct },
						}),
				),
			);
			const { request, url } = buildPathRequest(`/p/${runId}/asset`);
			const res = await handler(request, url);
			expect(await res?.text()).toBe("/* :root { } */ /not/rewritten");
		}
	});

	test("does not re-inject when upstream HTML already declares <base>", async () => {
		const html = '<html><head><base href="/elsewhere/"></head><body>ok</body></html>';
		const handler = pathHandler(
			fetchStub(
				async () =>
					new Response(html, {
						status: 200,
						headers: { "content-type": "text/html" },
					}),
			),
		);
		const { request, url } = buildPathRequest(`/p/${runId}/`);
		const res = await handler(request, url);
		expect(await res?.text()).toBe(html);
	});

	test("skips rewriting when the upstream sets Content-Encoding", async () => {
		// Best-effort posture: with a Content-Encoding header in play we
		// cannot safely splice into the byte stream, so we pass through
		// rather than smuggle plaintext under a gzip label.
		const html = "<html><head></head><body>raw</body></html>";
		const handler = pathHandler(
			fetchStub(
				async () =>
					new Response(html, {
						status: 200,
						headers: {
							"content-type": "text/html",
							"content-encoding": "gzip",
						},
					}),
			),
		);
		const { request, url } = buildPathRequest(`/p/${runId}/`);
		const res = await handler(request, url);
		expect(await res?.text()).toBe(html);
	});

	test("rewrites a same-origin Location: header on 302", async () => {
		const handler = pathHandler(
			fetchStub(
				async () =>
					new Response("", {
						status: 302,
						headers: { location: "/signin" },
					}),
			),
		);
		const { request, url } = buildPathRequest(`/p/${runId}/private`);
		const res = await handler(request, url);
		expect(res?.status).toBe(302);
		expect(res?.headers.get("location")).toBe(`/p/${runId}/signin`);
	});

	test("leaves an absolute Location: untouched", async () => {
		const handler = pathHandler(
			fetchStub(
				async () =>
					new Response("", {
						status: 301,
						headers: { location: "https://example.com/elsewhere" },
					}),
			),
		);
		const { request, url } = buildPathRequest(`/p/${runId}/`);
		const res = await handler(request, url);
		expect(res?.headers.get("location")).toBe("https://example.com/elsewhere");
	});

	test("leaves a Location: already prefixed with /p/<id>/ untouched", async () => {
		const handler = pathHandler(
			fetchStub(
				async () =>
					new Response("", {
						status: 302,
						headers: { location: `/p/${runId}/already-there` },
					}),
			),
		);
		const { request, url } = buildPathRequest(`/p/${runId}/`);
		const res = await handler(request, url);
		expect(res?.headers.get("location")).toBe(`/p/${runId}/already-there`);
	});

	test("does not rewrite Location: on a non-3xx status", async () => {
		// Location may legally appear on 201 Created — leave it alone.
		const handler = pathHandler(
			fetchStub(
				async () =>
					new Response("{}", {
						status: 201,
						headers: { location: "/things/42", "content-type": "application/json" },
					}),
			),
		);
		const { request, url } = buildPathRequest(`/p/${runId}/things`);
		const res = await handler(request, url);
		expect(res?.headers.get("location")).toBe("/things/42");
	});
});

describe("createPreviewProxyHandler (subdomain mode) — leaves HTML untouched", () => {
	let db: WarrenDb;
	let repos: Repos;
	let auth: PreviewAuth;
	let runId: string;

	beforeEach(async () => {
		db = await openDatabase({ path: ":memory:" });
		repos = createRepos(db);
		auth = createPreviewAuth(TOKEN, { secure: false });
		await repos.agents.upsert({ name: "agent", renderedJson: { sections: {} } });
		const project = await repos.projects.create({
			gitUrl: "https://github.com/x/y.git",
			localPath: "/data/projects/x/y",
			defaultBranch: "main",
		});
		const run = await repos.runs.create({
			agentName: "agent",
			projectId: project.id,
			prompt: "p",
			renderedAgentJson: {},
			trigger: "manual",
			burrowId: "bur_x",
			workerId: LOCAL_WORKER_NAME,
		});
		runId = run.id;
		await repos.runs.attachPreview(runId, {
			previewState: "live",
			previewPort: 30300,
			previewStartedAt: "2026-01-01T00:00:00Z",
			previewLastHitAt: "2026-01-01T00:00:00Z",
		});
	});

	afterEach(async () => {
		await db.close();
	});

	test("subdomain mode passes text/html through byte-for-byte (no <base> injection)", async () => {
		const html = "<html><head><title>x</title></head><body>ok</body></html>";
		const handler = createPreviewProxyHandler({
			repos,
			previewAuth: auth,
			config: { mode: "subdomain", host: HOST },
			fetch: fetchStub(
				async () =>
					new Response(html, {
						status: 200,
						headers: { "content-type": "text/html" },
					}),
			),
		});
		const c = auth.signCookie(runId, new Date());
		const request = new Request(`http://run-${runId}.${HOST}/`, {
			headers: {
				host: `run-${runId}.${HOST}`,
				cookie: `${COOKIE_NAME}=${c.value}`,
			},
		});
		const url = new URL(request.url);
		const res = await handler(request, url);
		expect(await res?.text()).toBe(html);
	});

	test("subdomain mode passes Location: through verbatim on 302", async () => {
		const handler = createPreviewProxyHandler({
			repos,
			previewAuth: auth,
			config: { mode: "subdomain", host: HOST },
			fetch: fetchStub(
				async () => new Response("", { status: 302, headers: { location: "/signin" } }),
			),
		});
		const c = auth.signCookie(runId, new Date());
		const request = new Request(`http://run-${runId}.${HOST}/private`, {
			headers: {
				host: `run-${runId}.${HOST}`,
				cookie: `${COOKIE_NAME}=${c.value}`,
			},
		});
		const url = new URL(request.url);
		const res = await handler(request, url);
		expect(res?.headers.get("location")).toBe("/signin");
	});
});
