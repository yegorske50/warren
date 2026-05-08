import { describe, expect, test } from "bun:test";
import { generateId, isId } from "./ids.ts";

describe("generateId", () => {
	test("project ids start with prj_ and have a 12-char base32 suffix", () => {
		const id = generateId("project");
		expect(id).toMatch(/^prj_[0-9abcdefghjkmnpqrstvwxyz]{12}$/);
	});

	test("run ids start with run_", () => {
		const id = generateId("run");
		expect(id).toMatch(/^run_[0-9abcdefghjkmnpqrstvwxyz]{12}$/);
	});

	test("ids are unique across many generations", () => {
		const set = new Set<string>();
		for (let i = 0; i < 1000; i++) set.add(generateId("project"));
		expect(set.size).toBe(1000);
	});
});

describe("isId", () => {
	test("accepts a freshly generated id of the same kind", () => {
		const id = generateId("run");
		expect(isId("run", id)).toBe(true);
	});

	test("rejects an id of a different kind", () => {
		const id = generateId("project");
		expect(isId("run", id)).toBe(false);
	});

	test("rejects malformed strings, non-strings, and wrong-length suffixes", () => {
		expect(isId("project", "")).toBe(false);
		expect(isId("project", "prj_")).toBe(false);
		expect(isId("project", "prj_short")).toBe(false);
		expect(isId("project", "prj_TOOLONGTOOLONGTOO")).toBe(false);
		expect(isId("project", "prj_12345678901I")).toBe(false); // I is not in base32 alphabet
		expect(isId("project", 123 as unknown)).toBe(false);
	});
});
