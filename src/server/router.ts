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
		const compiled = compileForRoute(route);
		const match = compiled.regex.exec(normalised);
		if (!match) continue;
		const params: Record<string, string> = {};
		compiled.paramNames.forEach((name, i) => {
			const value = match[i + 1];
			if (value !== undefined) params[name] = decodeURIComponent(value);
		});
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
		if (compileForRoute(route).regex.test(normalised)) return true;
	}
	return false;
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
