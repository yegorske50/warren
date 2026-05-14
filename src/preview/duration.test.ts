import { describe, expect, test } from "bun:test";
import { ValidationError } from "../core/errors.ts";
import { parseDurationMs } from "./duration.ts";

describe("parseDurationMs", () => {
	test("parses single-unit values", () => {
		expect(parseDurationMs("30m")).toBe(30 * 60_000);
		expect(parseDurationMs("8h")).toBe(8 * 3_600_000);
		expect(parseDurationMs("500ms")).toBe(500);
		expect(parseDurationMs("2s")).toBe(2_000);
		expect(parseDurationMs("1d")).toBe(86_400_000);
	});

	test("parses compound durations", () => {
		expect(parseDurationMs("1h30m")).toBe(3_600_000 + 30 * 60_000);
		expect(parseDurationMs("1h30m15s")).toBe(3_600_000 + 30 * 60_000 + 15_000);
	});

	test("ignores surrounding whitespace", () => {
		expect(parseDurationMs("  10m ")).toBe(10 * 60_000);
	});

	test("rejects malformed input", () => {
		expect(() => parseDurationMs("")).toThrow(ValidationError);
		expect(() => parseDurationMs("30")).toThrow(ValidationError);
		expect(() => parseDurationMs("m")).toThrow(ValidationError);
		expect(() => parseDurationMs("30x")).toThrow(ValidationError);
		expect(() => parseDurationMs("-5m")).toThrow(ValidationError);
		expect(() => parseDurationMs("1.5h")).toThrow(ValidationError);
	});
});
