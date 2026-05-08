import { describe, expect, test } from "bun:test";
import { ValidationError } from "../core/errors.ts";
import { formatError, writeJsonLine } from "./output.ts";

describe("writeJsonLine", () => {
	test("writes a single newline-terminated JSON object", () => {
		const chunks: string[] = [];
		writeJsonLine({ write: (c) => chunks.push(c) }, { ok: true, n: 2 });
		expect(chunks).toEqual([`${JSON.stringify({ ok: true, n: 2 })}\n`]);
	});
});

describe("formatError", () => {
	test("formats a WarrenError with code and recovery hint", () => {
		const err = new ValidationError("boom", { recoveryHint: "set FOO=1" });
		expect(formatError(err)).toBe("[validation_error] boom\n  hint: set FOO=1");
	});

	test("formats a plain Error without code or hint", () => {
		expect(formatError(new Error("oops"))).toBe("oops");
	});

	test("stringifies a non-Error", () => {
		expect(formatError(42)).toBe("42");
	});
});
