/**
 * Route-matching parsers for the preview proxy (warren-b902 split of
 * src/preview/proxy/index.ts; original framing in proxy/index.ts).
 *
 * Three matchers cover the proxy's two routing modes:
 *
 *   - `parseRunIdFromHost` — subdomain mode (`run-<runId>.<host>`).
 *   - `parsePreviewPathPrefix` — path mode (`/p/<runId>/...`).
 *   - `parseRunIdFromReferer` — path mode asset routing fallback
 *     (warren-63e1): when an asset request like
 *     `GET /_next/static/foo.js` doesn't itself match `/p/...` but its
 *     `Referer:` does, route it to that preview.
 *
 * The old `isWarrenApiPath` carve-out is gone (warren-3f8a): the
 * path-mode proxy now runs on a dedicated preview listener that serves
 * nothing but previews, so there is no warren API on this origin for
 * the referer fallback to protect. A preview reaching for the control
 * plane must cross origins explicitly, which is the point.
 */

/** URL path prefix the path-mode matcher anchors to (`/p/<runId>/...`). */
export const PREVIEW_PATH_PREFIX = "/p";

/**
 * Match `run-<runId>.<host>` against `Host:`. Returns the runId on a
 * match, `null` otherwise. Tolerates an optional `:port` suffix because
 * Caddy / ingress edges sometimes preserve the upstream port in the Host
 * header (especially on `http://` dev deploys).
 */
export function parseRunIdFromHost(hostHeader: string | null, suffix: string): string | null {
	if (hostHeader === null || hostHeader.length === 0) return null;
	// Strip optional `:port`.
	const colon = hostHeader.lastIndexOf(":");
	const host =
		colon !== -1 && /^\d+$/.test(hostHeader.slice(colon + 1))
			? hostHeader.slice(0, colon)
			: hostHeader;
	if (host === suffix) return null;
	const suffixDot = `.${suffix}`;
	if (!host.endsWith(suffixDot)) return null;
	const prefix = host.slice(0, host.length - suffixDot.length);
	if (!prefix.startsWith("run-")) return null;
	const runId = prefix.slice("run-".length);
	if (runId.length === 0) return null;
	// runIds are generated as `run_<base32>` (see `generateId`). The dot is
	// disallowed in run subdomains; reject anything else so a multi-label
	// `Host: deeper.run-X.<host>` doesn't accidentally route here.
	if (runId.includes(".")) return null;
	return runId;
}

/**
 * Match `/p/<runId>` (with optional `/<rest>`) on a URL pathname.
 * Returns `{runId, rest}` where `rest` is the remainder of the path
 * (always starts with `/`; defaults to `/` when the request was for
 * `/p/<runId>` with no trailing slash). Returns null when the path
 * doesn't match the preview prefix — the caller falls through to the
 * regular pipeline.
 *
 * The runId charset is intentionally permissive (`[A-Za-z0-9_-]+`) so
 * any future change to `generateId`'s alphabet keeps matching; the
 * DB lookup (`repos.runs.get`) is the actual source of truth and
 * issues a 404 for unknown IDs. The single-segment shape (no `/`,
 * no `.`) is what protects against path-traversal escapes from the
 * prefix.
 */
export function parsePreviewPathPrefix(pathname: string): { runId: string; rest: string } | null {
	const match = /^\/p\/([A-Za-z0-9_-]+)(\/.*)?$/.exec(pathname);
	if (match === null) return null;
	const runId = match[1];
	if (runId === undefined || runId.length === 0) return null;
	const rest = match[2] ?? "/";
	return { runId, rest };
}

/**
 * Extract a runId from a `Referer:` header (warren-63e1). Parses the
 * header value as a URL and matches `parsePreviewPathPrefix` on the
 * pathname. Returns null when the header is missing, malformed, or
 * does not point at a `/p/<runId>/...` page — the proxy preamble
 * falls through to the regular pipeline in those cases.
 *
 * Origin is not constrained: a same-host referer is the common path
 * (browser default policy), but a cross-origin referer that still
 * names `/p/<runId>/...` is acceptable because the cookie check
 * downstream still anchors on the runId-bound signature.
 */
export function parseRunIdFromReferer(refererHeader: string | null): string | null {
	if (refererHeader === null || refererHeader.length === 0) return null;
	let url: URL;
	try {
		url = new URL(refererHeader);
	} catch {
		return null;
	}
	const parsed = parsePreviewPathPrefix(url.pathname);
	return parsed === null ? null : parsed.runId;
}
