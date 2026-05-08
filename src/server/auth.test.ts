import { describe, expect, test } from "bun:test";
import { ValidationError } from "../core/errors.ts";
import { bearerAuth, NO_AUTH, resolveAuth } from "./auth.ts";

function req(authorization?: string): Request {
	const headers: Record<string, string> = {};
	if (authorization !== undefined) headers.authorization = authorization;
	return new Request("http://localhost/test", { headers });
}

describe("NO_AUTH", () => {
	test("allows every request, including unauthenticated ones", () => {
		expect(NO_AUTH.authorize(req()).ok).toBe(true);
		expect(NO_AUTH.authorize(req("Bearer anything")).ok).toBe(true);
	});
});

describe("bearerAuth", () => {
	test("rejects missing header with 401 + WWW-Authenticate", () => {
		const provider = bearerAuth("secret");
		const result = provider.authorize(req());
		expect(result.ok).toBe(false);
		if (result.ok) return;
		expect(result.status).toBe(401);
		expect(result.code).toBe("unauthorized");
		expect(result.challenge).toContain('Bearer realm="warren"');
	});

	test("rejects malformed Authorization header", () => {
		const provider = bearerAuth("secret");
		const result = provider.authorize(req("Basic abc"));
		expect(result.ok).toBe(false);
		if (result.ok) return;
		expect(result.status).toBe(401);
		expect(result.challenge).toContain("invalid_request");
	});

	test("rejects an invalid token", () => {
		const provider = bearerAuth("secret");
		const result = provider.authorize(req("Bearer wrong"));
		expect(result.ok).toBe(false);
		if (result.ok) return;
		expect(result.status).toBe(401);
		expect(result.challenge).toContain("invalid_token");
	});

	test("accepts the matching token (case-insensitive scheme)", () => {
		const provider = bearerAuth("s3cret");
		expect(provider.authorize(req("Bearer s3cret")).ok).toBe(true);
		expect(provider.authorize(req("bearer s3cret")).ok).toBe(true);
	});

	test("rejects a same-prefix token of different length", () => {
		const provider = bearerAuth("secret");
		const result = provider.authorize(req("Bearer secretX"));
		expect(result.ok).toBe(false);
	});

	test("throws on construction with empty token", () => {
		expect(() => bearerAuth("")).toThrow();
	});
});

describe("resolveAuth", () => {
	test("noAuth wins over everything else", () => {
		const provider = resolveAuth({
			noAuth: true,
			token: "ignored",
			env: { WARREN_API_TOKEN: "x" },
		});
		expect(provider).toBe(NO_AUTH);
	});

	test("explicit token wins over env", () => {
		const provider = resolveAuth({ token: "explicit", env: { WARREN_API_TOKEN: "fromenv" } });
		const ok = provider.authorize(req("Bearer explicit"));
		expect(ok.ok).toBe(true);
		const bad = provider.authorize(req("Bearer fromenv"));
		expect(bad.ok).toBe(false);
	});

	test("falls back to env.WARREN_API_TOKEN", () => {
		const provider = resolveAuth({ env: { WARREN_API_TOKEN: "fromenv" } });
		expect(provider.authorize(req("Bearer fromenv")).ok).toBe(true);
	});

	test("throws ValidationError when token is missing and noAuth is not set", () => {
		expect(() => resolveAuth({ env: {} })).toThrow(ValidationError);
	});

	test("throws ValidationError on empty token", () => {
		expect(() => resolveAuth({ env: { WARREN_API_TOKEN: "" } })).toThrow(ValidationError);
	});
});
