import { describe, expect, test } from "bun:test";
import { ValidationError } from "../core/errors.ts";
import { rescueBranchFor, salvageBundleFileName, salvageBundlePath } from "./salvage.ts";

describe("rescueBranchFor", () => {
	test("namespaces the rescue branch under warren/rescue/", () => {
		expect(rescueBranchFor("run_abc123")).toBe("warren/rescue/run_abc123");
	});
});

describe("salvageBundleFileName", () => {
	test("suffixes the run id with .bundle", () => {
		expect(salvageBundleFileName("run_abc123")).toBe("run_abc123.bundle");
	});
});

/**
 * warren-7c1e: `POST /runs/:id/salvage` reaches this resolver with a
 * percent-decoded route param, so the sink — not just the router — has to
 * refuse anything that would place the write outside the salvage directory.
 */
describe("salvageBundlePath", () => {
	test("resolves a normal run id to a direct child of the salvage dir", () => {
		expect(salvageBundlePath("/data/salvage", "run_abc123")).toBe(
			"/data/salvage/run_abc123.bundle",
		);
	});

	test("normalises a non-canonical salvage dir without escaping it", () => {
		expect(salvageBundlePath("/data/./salvage/", "run_abc123")).toBe(
			"/data/salvage/run_abc123.bundle",
		);
	});

	test("refuses a run id that traverses out of the salvage dir", () => {
		expect(() => salvageBundlePath("/data/salvage", "../../../etc/pwn")).toThrow(ValidationError);
		expect(() => salvageBundlePath("/data/salvage", "..")).toThrow(ValidationError);
		expect(() => salvageBundlePath("/data/salvage", ".")).toThrow(ValidationError);
	});

	test("refuses an absolute run id", () => {
		expect(() => salvageBundlePath("/data/salvage", "/etc/pwn")).toThrow(ValidationError);
	});

	test("refuses separators, NUL, and whitespace-bearing run ids", () => {
		for (const bad of ["a/b", "a\\b", "a\0b", "a b", ""]) {
			expect(() => salvageBundlePath("/data/salvage", bad)).toThrow(ValidationError);
		}
	});
});
