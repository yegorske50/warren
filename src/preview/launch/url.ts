/**
 * Env-driven preview launch config + URL formatting (extracted in
 * warren-62a7 / pl-9088 step 9). `WARREN_PREVIEW_HOST` and
 * `WARREN_PREVIEW_MODE` are read once at server boot via
 * `loadPreviewLaunchConfigFromEnv`; `formatPreviewUrl` renders the
 * reviewer-facing URL for a `live` preview in either mode.
 *
 * Kept separate from the orchestration code because both the server
 * bootstrap (`src/server/main/index.ts`, `src/server/bridges.ts`) and the UI
 * (via `formatPreviewUrl`'s spec, mirrored in `src/ui/src/api/client.ts`)
 * depend on these helpers without ever touching the launch state machine.
 */

import {
	DEFAULT_PREVIEW_MODE,
	type PreviewMode,
	PreviewModeSchema,
} from "../../warren-config/index.ts";

export const WARREN_PREVIEW_HOST_ENV = "WARREN_PREVIEW_HOST" as const;
export const WARREN_PREVIEW_MODE_ENV = "WARREN_PREVIEW_MODE" as const;
export const WARREN_PREVIEW_PORT_ENV = "WARREN_PREVIEW_PORT" as const;

export interface PreviewLaunchConfig {
	/**
	 * Host suffix the proxy preamble matches on (`Host: run-<id>.<host>`).
	 * Null when the operator hasn't wired the proxy yet — `preview_launch`
	 * still runs (the eviction worker / manual teardown all key off
	 * `runs.preview_state`), but `pr_annotate_preview` skips because there
	 * is no URL to publish.
	 *
	 * In path mode (default, warren-fcb7 / docs/design/preview-environments.md path addendum) the proxy
	 * preamble derives the preview origin from the request's own `Host` and
	 * routes by path prefix, so `host` being null no longer disables the
	 * preview surface — only subdomain mode still requires this to be set.
	 */
	readonly host: string | null;
	/**
	 * Routing mode for previews (warren-fcb7 / docs/design/preview-environments.md path addendum).
	 * `path` (default): previews served at `https://<warren-host>/p/<run-id>/`.
	 * `subdomain`: previews served at `https://run-<id>.<host>/`. The env
	 * surface wins over any per-project `.warren/preview.yaml` `mode` pin
	 * (merge precedence enforced by the call site, not here).
	 */
	readonly mode: PreviewMode;
	/**
	 * TCP port of the dedicated path-mode preview listener (warren-3f8a).
	 * Path-mode previews are served from their own listener so the browser
	 * origin differs from the warren UI's — same-origin preview code must
	 * not be able to read the operator token out of the UI's storage. Null
	 * when `WARREN_PREVIEW_PORT` is unset or invalid; the boot path then
	 * derives `<bind port> + 1` (or an ephemeral port when the bind port
	 * itself is ephemeral). Subdomain mode ignores this — its origin
	 * boundary comes from the per-run host.
	 */
	readonly port: number | null;
}

export type PreviewLaunchEnvLike = Readonly<Record<string, string | undefined>>;

export function loadPreviewLaunchConfigFromEnv(
	env: PreviewLaunchEnvLike = process.env,
): PreviewLaunchConfig {
	const rawHost = env[WARREN_PREVIEW_HOST_ENV];
	const trimmedHost = rawHost === undefined ? "" : rawHost.trim();
	const host = trimmedHost === "" ? null : trimmedHost;

	const rawMode = env[WARREN_PREVIEW_MODE_ENV];
	const trimmedMode = rawMode === undefined ? "" : rawMode.trim().toLowerCase();
	// Invalid / empty value silently falls back to DEFAULT_PREVIEW_MODE — the
	// env knob mirrors how other WARREN_PREVIEW_* values degrade (mx-d3b88f)
	// rather than blocking server boot. Doctor / readyz callers can layer on
	// a strict validation pass later if operators want one.
	const parsedMode = PreviewModeSchema.safeParse(trimmedMode);
	const mode: PreviewMode = parsedMode.success ? parsedMode.data : DEFAULT_PREVIEW_MODE;

	// Invalid / empty port degrades to null like the other WARREN_PREVIEW_*
	// knobs (mx-d3b88f); the boot path substitutes `<bind port> + 1`.
	const rawPort = env[WARREN_PREVIEW_PORT_ENV];
	const trimmedPort = rawPort === undefined ? "" : rawPort.trim();
	const parsedPort = Number.parseInt(trimmedPort, 10);
	const port =
		trimmedPort !== "" &&
		Number.isInteger(parsedPort) &&
		String(parsedPort) === trimmedPort &&
		parsedPort >= 1 &&
		parsedPort <= 65535
			? parsedPort
			: null;

	return { host, mode, port };
}

/**
 * Format the preview URL for a `live` preview. The host suffix is the
 * operator's `WARREN_PREVIEW_HOST`; URLs are always `https` per SECURITY.md
 * (TLS terminates on the operator's reverse proxy).
 *
 * - **Subdomain mode** (`https://run-<id>.<host>`): the reviewer-facing
 *   shape from the original docs/design/preview-environments.md. No trailing slash so the URL stays
 *   stable across modes and existing PR annotations.
 * - **Path mode** (`https://<host>:<port>/p/<id>/`, warren-c3c4 / docs/design/preview-environments.md
 *   addendum): trailing slash is load-bearing — without it the browser
 *   resolves the upstream's root-relative HTML (`href="/assets/foo"`)
 *   against `/p/` instead of `/p/<id>/`, defeating the proxy preamble.
 *   `port` is the dedicated preview listener's port (warren-3f8a); null
 *   keeps the URL portless for callers that predate the split listener.
 */
export function formatPreviewUrl(
	runId: string,
	host: string,
	mode: PreviewMode,
	port: number | null = null,
): string {
	if (mode === "path") {
		const authority = port === null ? host : `${host}:${port}`;
		return `https://${authority}/p/${runId}/`;
	}
	return `https://run-${runId}.${host}`;
}
