import { describe, expect, test } from "bun:test";
import { parseWarrenServerFileConfig } from "./schema.ts";

describe("parseWarrenServerFileConfig", () => {
	test("undefined → empty config", () => {
		const result = parseWarrenServerFileConfig(undefined);
		expect(result.ok).toBe(true);
		if (result.ok) expect(result.value).toEqual({});
	});

	test("null → empty config (defensive: TOML rarely produces null at root)", () => {
		const result = parseWarrenServerFileConfig(null);
		expect(result.ok).toBe(true);
		if (result.ok) expect(result.value).toEqual({});
	});

	test("empty object → empty config", () => {
		const result = parseWarrenServerFileConfig({});
		expect(result.ok).toBe(true);
		if (result.ok) expect(result.value).toEqual({});
	});

	test("unknown top-level key → not ok (strict schema until step 8 adds workers)", () => {
		const result = parseWarrenServerFileConfig({ workers: [{ name: "a" }] });
		expect(result.ok).toBe(false);
		if (!result.ok) expect(result.message).toMatch(/workers/);
	});

	test("non-object root → not ok", () => {
		const result = parseWarrenServerFileConfig("not an object");
		expect(result.ok).toBe(false);
	});
});
