/**
 * Pure pattern-matching router for the warren HTTP server.
 *
 * `compilePattern` turns a `/runs/:id/events` template into a regex plus
 * an ordered `paramNames` list. `matchRoute` walks the route table and
 * returns the first match (with extracted params) or null.
 *
 * Synchronous, side-effect-free, and zero-dependency — dispatch (calling
 * the handler, rendering the response) lives in `./server.ts`. Trailing
 * slashes are normalised at the request boundary so `/agents` and
 * `/agents/` resolve to the same route, matching burrow's posture.
 *
 * **Params are percent-decoded, and that decode is a trust boundary
 * (warren-7c1e).** `:param` compiles to `([^/]+)`, which constrains the
 * RAW pathname — but `URL.pathname` preserves `%2F`, so a raw segment of
 * `..%2F..%2Fetc%2Fpwn` matches a single-segment pattern and then decodes
 * to `../../etc/pwn`. Handlers reasonably treat a route param as one
 * opaque segment; `POST /runs/:id/salvage` joined it straight onto the
 * salvage directory, which turned that into an arbitrary file write. So
 * the decode is validated HERE, once, rather than in each handler:
 *
 *   - a decoded value carrying a path separator (`/`, `\`) or a NUL is
 *     refused — nothing in `ROUTE_TABLE` models a multi-segment param, so
 *     there is no legitimate caller to break;
 *   - a malformed escape (`%ZZ`) is refused instead of throwing. It used
 *     to raise `URIError` out of `matchRoute`, which `handleRequest` calls
 *     OUTSIDE its try/catch — a post-auth request could crash the pipeline
 *     into Bun's default 500 rather than warren's error envelope.
 *
 * Either way the route simply does not match, so the request lands on the
 * canonical 404 envelope. `pathExists` applies the same rule, so a refused
 * param reports 404 (no such resource) rather than 405 (wrong verb).
 */

import type { HttpMethod, Route, RoutePattern } from "./types.ts";

interface MatchResult {
	readonly route: Route;
	readonly params: Readonly<Record<string, string>>;
}

const PARAM_RE = /:([A-Za-z_][A-Za-z0-9_]*)/g;

export function compilePattern(method: HttpMethod, pattern: string): RoutePattern {
	if (!pattern.startsWith("/")) {
		throw new Error(`route pattern must start with '/': ${pattern}`);
	}
	const paramNames: string[] = [];
	const regexSource = pattern
		.replace(/[.+^${}()|[\]\\]/g, "\\$&")
		.replace(PARAM_RE, (_match, name: string) => {
			paramNames.push(name);
			return "([^/]+)";
		});
	return {
		method,
		pattern,
		regex: new RegExp(`^${regexSource}$`),
		paramNames,
	};
}

export function matchRoute(
	routes: readonly Route[],
	method: string,
	pathname: string,
): MatchResult | null {
	const normalised = normalisePathname(pathname);
	const upperMethod = method.toUpperCase();
	for (const route of routes) {
		if (route.method !== upperMethod) continue;
		const params = matchPattern(compileForRoute(route), normalised);
		if (params === null) continue;
		return { route, params };
	}
	return null;
}

/**
 * True iff some route matches `pathname` for any verb. Lets the dispatch
 * layer return 405 (resource exists, wrong verb) instead of 404 (no
 * such resource) when the path is known but the method isn't.
 */
export function pathExists(routes: readonly Route[], pathname: string): boolean {
	const normalised = normalisePathname(pathname);
	for (const route of routes) {
		if (matchPattern(compileForRoute(route), normalised) !== null) return true;
	}
	return false;
}

/**
 * Characters a decoded route param may never carry. `/` and `\` would let
 * one segment express a path (the `join()`-into-a-data-dir hazard);
 * `\0` truncates in any C-string boundary a value is later handed to.
 */
const FORBIDDEN_PARAM_CHARS = /[/\\\0]/;

/**
 * Percent-decode one raw path segment, or `null` when it must not be
 * admitted — a malformed escape, or a decoded value carrying a path
 * separator / NUL. See the module doc for why this is a route-layer
 * decision rather than a per-handler one.
 */
function decodeParam(raw: string): string | null {
	let decoded: string;
	try {
		decoded = decodeURIComponent(raw);
	} catch {
		return null;
	}
	return FORBIDDEN_PARAM_CHARS.test(decoded) ? null : decoded;
}

/**
 * Match one compiled pattern against an already-normalised pathname,
 * returning its decoded params (`{}` for a static pattern) or `null` when
 * the pattern doesn't match OR a param fails {@link decodeParam}. Shared
 * by `matchRoute` and `pathExists` so the two can never disagree about
 * what counts as a match.
 */
function matchPattern(
	compiled: RoutePattern,
	normalised: string,
): Readonly<Record<string, string>> | null {
	const match = compiled.regex.exec(normalised);
	if (!match) return null;
	const params: Record<string, string> = {};
	for (const [i, name] of compiled.paramNames.entries()) {
		const raw = match[i + 1];
		if (raw === undefined) continue;
		const decoded = decodeParam(raw);
		if (decoded === null) return null;
		params[name] = decoded;
	}
	return params;
}

function normalisePathname(pathname: string): string {
	if (pathname.length > 1 && pathname.endsWith("/")) {
		return pathname.slice(0, -1);
	}
	return pathname;
}

const compileCache = new WeakMap<Route, RoutePattern>();

function compileForRoute(route: Route): RoutePattern {
	const cached = compileCache.get(route);
	if (cached) return cached;
	const compiled = compilePattern(route.method, route.pattern);
	compileCache.set(route, compiled);
	return compiled;
}
