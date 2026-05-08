/**
 * Bearer-token auth for `warren serve` (SPEC §8.1).
 *
 * V1 posture is single-user (SPEC §3.2 / §11.D): one bearer token from
 * `WARREN_API_TOKEN`, missing/invalid → 401. The `AuthProvider` seam
 * exists so a future multi-user landing (per-token scopes, OIDC, ...)
 * can plug in additively without rewriting handlers.
 *
 * `--no-auth` (loopback-only) is the dev-loop escape hatch. The CLI
 * plumbs it through `resolveAuth({ noAuth: true })`; the server itself
 * never inspects the flag (auth is opaque to dispatch).
 *
 * Token comparison uses `timingSafeEqual` after a length pre-check so a
 * mismatched-length token still resolves in roughly the same time as a
 * matched-length one. This mirrors burrow's auth.ts; same posture, same
 * threat-model assumption (single-user, single-token).
 */

import { timingSafeEqual } from "node:crypto";
import { ValidationError } from "../core/errors.ts";
import type { AuthDenied, AuthOk, AuthOutcome, AuthProvider } from "./types.ts";

const ALLOW: AuthOk = { ok: true };

class NoAuthProvider implements AuthProvider {
	authorize(): AuthOutcome {
		return ALLOW;
	}
}

class BearerTokenAuth implements AuthProvider {
	private readonly tokenBytes: Uint8Array;

	constructor(token: string) {
		if (token.length === 0) {
			throw new Error("bearerAuth: token must be a non-empty string");
		}
		this.tokenBytes = new TextEncoder().encode(token);
	}

	authorize(request: Request): AuthOutcome {
		const header = request.headers.get("authorization");
		if (header === null) {
			return deny(401, "unauthorized", "missing Authorization header", 'Bearer realm="warren"');
		}
		const match = /^Bearer\s+(\S+)\s*$/i.exec(header);
		if (!match?.[1]) {
			return deny(
				401,
				"unauthorized",
				"expected 'Bearer <token>' Authorization header",
				'Bearer realm="warren", error="invalid_request"',
			);
		}
		if (!constantTimeEqualString(match[1], this.tokenBytes)) {
			return deny(
				401,
				"unauthorized",
				"invalid bearer token",
				'Bearer realm="warren", error="invalid_token"',
			);
		}
		return ALLOW;
	}
}

/** Allow every request. Used by `--no-auth` / loopback-only deploys. */
export const NO_AUTH: AuthProvider = new NoAuthProvider();

/** Build an AuthProvider that requires a single bearer token. */
export function bearerAuth(token: string): AuthProvider {
	return new BearerTokenAuth(token);
}

export interface ResolveAuthOptions {
	/** Skip auth entirely (CLI `--no-auth`). Wins over every other field. */
	noAuth?: boolean;
	/** Explicit token (test fixtures, mostly). Wins over env. */
	token?: string;
	/** Environment to read from. Defaults to `process.env`. */
	env?: Readonly<Record<string, string | undefined>>;
}

/**
 * Resolve an AuthProvider from CLI inputs.
 *
 * Precedence: `noAuth` > `token` > `env.WARREN_API_TOKEN`. Throws
 * `ValidationError` if no token is found and `noAuth` is not set; the
 * CLI will surface that as a non-zero exit.
 */
export function resolveAuth(opts: ResolveAuthOptions = {}): AuthProvider {
	if (opts.noAuth) return NO_AUTH;
	const env = opts.env ?? process.env;
	const token = opts.token ?? env.WARREN_API_TOKEN;
	if (token === undefined || token.length === 0) {
		throw new ValidationError("WARREN_API_TOKEN is not set", {
			recoveryHint: "export WARREN_API_TOKEN=<token> or pass --no-auth (loopback only)",
		});
	}
	return bearerAuth(token);
}

function deny(status: number, code: string, message: string, challenge?: string): AuthDenied {
	return challenge !== undefined
		? { ok: false, status, code, message, challenge }
		: { ok: false, status, code, message };
}

function constantTimeEqualString(candidate: string, expected: Uint8Array): boolean {
	const candidateBytes = new TextEncoder().encode(candidate);
	if (candidateBytes.length !== expected.length) return false;
	return timingSafeEqual(candidateBytes, expected);
}
