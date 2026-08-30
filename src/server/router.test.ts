import { describe, expect, test } from "bun:test";
import { compilePattern, matchRoute, pathExists } from "./router.ts";
import type { Route } from "./types.ts";

const noopHandler = () => new Response();

const routes: Route[] = [
	{ method: "GET", pattern: "/agents", policy: "readPublic", handler: noopHandler },
	{ method: "POST", pattern: "/agents/refresh", policy: "admin", handler: noopHandler },
	{ method: "GET", pattern: "/agents/:name", policy: "readPublic", handler: noopHandler },
	{ method: "GET", pattern: "/runs/:id/events", policy: "readPublic", handler: noopHandler },
	{ method: "POST", pattern: "/runs/:id/cancel", policy: "dispatch", handler: noopHandler },
];

describe("compilePattern", () => {
	test("captures named params in order", () => {
		const p = compilePattern("GET", "/runs/:id/events/:seq");
		expect(p.paramNames).toEqual(["id", "seq"]);
		expect(p.regex.test("/runs/abc/events/42")).toBe(true);
		expect(p.regex.test("/runs/abc/events")).toBe(false);
	});

	test("throws when pattern does not start with /", () => {
		expect(() => compilePattern("GET", "agents")).toThrow();
	});

	test("escapes regex metachars in static segments", () => {
		const p = compilePattern("GET", "/foo.bar");
		expect(p.regex.test("/foo.bar")).toBe(true);
		expect(p.regex.test("/fooXbar")).toBe(false);
	});
});

describe("matchRoute", () => {
	test("matches the first route by method + pattern", () => {
		const m = matchRoute(routes, "GET", "/agents");
		expect(m?.route.pattern).toBe("/agents");
	});

	test("populates params from the URL path", () => {
		const m = matchRoute(routes, "GET", "/agents/refactor-bot");
		expect(m?.route.pattern).toBe("/agents/:name");
		expect(m?.params).toEqual({ name: "refactor-bot" });
	});

	test("decodes URL-encoded params", () => {
		const m = matchRoute(routes, "GET", "/agents/with%20space");
		expect(m?.params.name).toBe("with space");
	});

	test("static segments win over param segments when both could match", () => {
		const m = matchRoute(routes, "POST", "/agents/refresh");
		expect(m?.route.pattern).toBe("/agents/refresh");
	});

	test("verb mismatch returns null", () => {
		expect(matchRoute(routes, "PUT", "/agents")).toBeNull();
	});

	test("trailing slash is normalised", () => {
		const m = matchRoute(routes, "GET", "/agents/");
		expect(m?.route.pattern).toBe("/agents");
	});

	test("case-insensitive method", () => {
		const m = matchRoute(routes, "get", "/agents");
		expect(m?.route.pattern).toBe("/agents");
	});

	test("unknown path returns null", () => {
		expect(matchRoute(routes, "GET", "/unknown")).toBeNull();
	});
});

describe("pathExists", () => {
	test("true when any verb matches", () => {
		expect(pathExists(routes, "/agents")).toBe(true);
		expect(pathExists(routes, "/agents/refresh")).toBe(true);
	});

	test("false when no verb matches", () => {
		expect(pathExists(routes, "/unknown")).toBe(false);
	});

	test("trailing slash normalised", () => {
		expect(pathExists(routes, "/agents/")).toBe(true);
	});
});

/**
 * warren-7c1e: `:param` compiles to `([^/]+)`, which constrains the RAW
 * pathname — but `URL.pathname` preserves `%2F`, so a raw segment can decode
 * into something that spans path segments. Handlers treat a param as one
 * opaque token (`POST /runs/:id/salvage` joined it onto the salvage dir),
 * so the decode is validated at the route layer.
 */
describe("matchRoute param decoding is a trust boundary", () => {
	test("a param that decodes to a path traversal does not match", () => {
		// The exact shape that reached `join(salvageDir, `${id}.bundle`)`.
		const pathname = new URL("http://x/runs/..%2F..%2F..%2Fetc%2Fpwn/cancel").pathname;
		expect(pathname).toBe("/runs/..%2F..%2F..%2Fetc%2Fpwn/cancel");
		expect(matchRoute(routes, "POST", pathname)).toBeNull();
	});

	test("a param carrying an encoded backslash or NUL does not match", () => {
		expect(matchRoute(routes, "GET", "/agents/a%5Cb")).toBeNull();
		expect(matchRoute(routes, "GET", "/agents/a%00b")).toBeNull();
	});

	test("a malformed percent-escape returns null instead of throwing URIError", () => {
		// `handleRequest` calls matchRoute OUTSIDE its try/catch, so a throw
		// here escaped the error pipeline into Bun's default 500.
		expect(() => matchRoute(routes, "POST", "/runs/%ZZ/cancel")).not.toThrow();
		expect(matchRoute(routes, "POST", "/runs/%ZZ/cancel")).toBeNull();
	});

	test("ordinary encoded params still decode", () => {
		expect(matchRoute(routes, "GET", "/agents/with%20space")?.params.name).toBe("with space");
		expect(matchRoute(routes, "GET", "/agents/dots.and-dashes_ok")?.params.name).toBe(
			"dots.and-dashes_ok",
		);
	});

	test("pathExists agrees, so a refused param is a 404 rather than a 405", () => {
		expect(pathExists(routes, "/runs/..%2F..%2Fetc%2Fpwn/cancel")).toBe(false);
		expect(pathExists(routes, "/runs/%ZZ/cancel")).toBe(false);
	});
});
