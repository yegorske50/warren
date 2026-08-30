import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { WarrenDb } from "../../db/client.ts";
import type { Repos } from "../../db/repos/index.ts";
import { createPreviewAuth, type PreviewAuth } from "../cookie.ts";
import { createPreviewProxyHandler } from "./index.ts";
import { fetchStub, HOST, setupProxyEnv, TOKEN } from "./test-helpers.ts";

describe("createPreviewProxyHandler (path mode) — referer routing (warren-63e1)", () => {
	let db: WarrenDb;
	let repos: Repos;
	let auth: PreviewAuth;
	let runId: string;

	beforeEach(async () => {
		({ db, repos, auth, runId } = await setupProxyEnv({ scope: "path", previewPort: 30400 }));
	});

	afterEach(async () => {
		await db.close();
	});

	function buildAssetRequest(opts: { path: string; referer?: string; cookieRunId?: string }): {
		request: Request;
		url: URL;
	} {
		const headers: Record<string, string> = { host: "warren.example.com" };
		if (opts.referer !== undefined) headers.referer = opts.referer;
		if (opts.cookieRunId !== undefined) {
			const c = auth.signCookie(opts.cookieRunId, new Date());
			headers.cookie = `${c.name}=${c.value}`;
		}
		const request = new Request(`http://warren.example.com${opts.path}`, { headers });
		return { request, url: new URL(request.url) };
	}

	test("routes a `/_next/static/...` asset to the preview when Referer names /p/<id>/", async () => {
		let upstreamUrl: string | undefined;
		const handler = createPreviewProxyHandler({
			repos,
			previewAuth: auth,
			config: { mode: "path" },
			fetch: fetchStub(async (input) => {
				upstreamUrl = typeof input === "string" ? input : (input as Request).url;
				return new Response("upstream-bundle", {
					status: 200,
					headers: { "content-type": "application/javascript" },
				});
			}),
		});
		const { request, url } = buildAssetRequest({
			path: "/_next/static/chunks/main.js",
			referer: `http://warren.example.com/p/${runId}/`,
			cookieRunId: runId,
		});
		const res = await handler(request, url);
		expect(res?.status).toBe(200);
		expect(await res?.text()).toBe("upstream-bundle");
		// The path is forwarded verbatim — upstream sees /_next/..., not /p/<id>/_next/...
		expect(upstreamUrl).toBe("http://127.0.0.1:30400/_next/static/chunks/main.js");
	});

	test("401 when the per-run cookie is missing on a referer-routed asset", async () => {
		const handler = createPreviewProxyHandler({
			repos,
			previewAuth: auth,
			config: { mode: "path" },
			fetch: fetchStub(async () => new Response("nope")),
		});
		const { request, url } = buildAssetRequest({
			path: "/_next/static/foo.js",
			referer: `http://warren.example.com/p/${runId}/`,
		});
		const res = await handler(request, url);
		expect(res?.status).toBe(401);
	});

	test("falls through (null) when no Referer header is present", async () => {
		const handler = createPreviewProxyHandler({
			repos,
			previewAuth: auth,
			config: { mode: "path" },
			fetch: fetchStub(async () => new Response("nope")),
		});
		const { request, url } = buildAssetRequest({ path: "/_next/static/foo.js" });
		// No /p/<id>/ in path AND no referer → fall through to warren's normal pipeline.
		expect(await handler(request, url)).toBeNull();
	});

	test("falls through when Referer points at a non-preview page", async () => {
		const handler = createPreviewProxyHandler({
			repos,
			previewAuth: auth,
			config: { mode: "path" },
			fetch: fetchStub(async () => new Response("nope")),
		});
		const { request, url } = buildAssetRequest({
			path: "/_next/static/foo.js",
			referer: "http://warren.example.com/runs",
		});
		expect(await handler(request, url)).toBeNull();
	});

	test("API-shaped paths referer-route to the preview upstream (warren-3f8a: no carve-out)", async () => {
		const handler = createPreviewProxyHandler({
			repos,
			previewAuth: auth,
			config: { mode: "path" },
			fetch: fetchStub(async () => new Response("upstream")),
		});
		// The path-mode handler runs on the dedicated preview listener now —
		// there is no warren API on this origin, so a path like
		// /runs/<id>/cancel with a /p/<id>/ referer belongs to the preview
		// app. The old isWarrenApiPath carve-out is gone by design: a preview
		// reaching for the control plane must cross origins explicitly.
		const cookie = auth.signCookie(runId, new Date());
		const request = new Request("http://warren.example.com/runs/run_unrelated/cancel", {
			headers: {
				host: "warren.example.com",
				referer: `http://warren.example.com/p/${runId}/`,
				cookie: `${cookie.name}=${cookie.value}`,
			},
		});
		const response = await handler(request, new URL(request.url));
		expect(response).not.toBeNull();
		expect(response?.status).toBe(200);
		expect(await response?.text()).toBe("upstream");
	});

	test("subdomain mode does not consult Referer (path-mode-only feature)", async () => {
		const subAuth = createPreviewAuth(TOKEN, { secure: false });
		const handler = createPreviewProxyHandler({
			repos,
			previewAuth: subAuth,
			config: { mode: "subdomain", host: HOST },
			fetch: fetchStub(async () => new Response("upstream")),
		});
		const request = new Request("http://warren.example.com/_next/static/foo.js", {
			headers: {
				host: "warren.example.com",
				referer: `http://run-${runId}.${HOST}/`,
			},
		});
		const url = new URL(request.url);
		// Subdomain mode keys off Host, which doesn't match the preview suffix
		// here; referer routing is path-mode-only by design (docs/design/preview-environments.md
		// addendum: subdomain mode owns its own DNS and emits absolute URLs
		// from the upstream's own origin).
		expect(await handler(request, url)).toBeNull();
	});
});
