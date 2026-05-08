import { describe, expect, test } from "bun:test";
import type { CliContext, EnvLike } from "../output.ts";
import { type DoctorCheck, runDoctor } from "./doctor.ts";

function captureContext(env: EnvLike = {}): {
	context: CliContext;
	out: string[];
	err: string[];
} {
	const out: string[] = [];
	const err: string[] = [];
	const context: CliContext = {
		env,
		stdio: {
			stdout: { write: (c) => out.push(c) },
			stderr: { write: (c) => err.push(c) },
		},
		spawn: async () => ({ stdout: "", stderr: "", exitCode: 0 }),
		now: () => new Date("2026-05-08T12:00:00.000Z"),
	};
	return { context, out, err };
}

describe("runDoctor", () => {
	test("flags missing env vars and exits 1", async () => {
		const { context } = captureContext({});
		const result = await runDoctor(
			context,
			{
				existsSync: () => true,
				probeBurrow: async () => undefined,
			},
			{},
		);
		expect(result.exitCode).toBe(1);
		const tokenCheck = result.checks.find((c: DoctorCheck) => c.name === "WARREN_API_TOKEN");
		expect(tokenCheck?.ok).toBe(false);
		const canopyCheck = result.checks.find((c: DoctorCheck) => c.name === "CANOPY_REPO_URL");
		expect(canopyCheck?.ok).toBe(false);
	});

	test("--no-auth exempts the WARREN_API_TOKEN check", async () => {
		const { context } = captureContext({
			CANOPY_REPO_URL: "https://example.com/agents.git",
		});
		const result = await runDoctor(
			context,
			{
				existsSync: () => true,
				probeBurrow: async () => undefined,
			},
			{ noAuth: true },
		);
		const tokenCheck = result.checks.find((c: DoctorCheck) => c.name === "WARREN_API_TOKEN");
		expect(tokenCheck?.ok).toBe(true);
		expect(tokenCheck?.message).toBe("skipped (--no-auth)");
		expect(result.exitCode).toBe(0);
	});

	test("flags an unreachable burrow with the probe error message", async () => {
		const { context } = captureContext({
			WARREN_API_TOKEN: "tok",
			CANOPY_REPO_URL: "https://example.com/agents.git",
		});
		const result = await runDoctor(
			context,
			{
				existsSync: () => true,
				probeBurrow: async () => {
					throw new Error("ECONNREFUSED /var/run/burrow.sock");
				},
			},
			{},
		);
		const burrowCheck = result.checks.find((c: DoctorCheck) => c.name === "burrow_reachable");
		expect(burrowCheck?.ok).toBe(false);
		expect(burrowCheck?.message).toContain("ECONNREFUSED");
		expect(result.exitCode).toBe(1);
	});

	test("flags a missing canopy clone directory", async () => {
		const { context } = captureContext({
			WARREN_API_TOKEN: "tok",
			CANOPY_REPO_URL: "https://example.com/agents.git",
			WARREN_CANOPY_DIR: "/nonexistent/canopy",
		});
		const result = await runDoctor(
			context,
			{
				existsSync: (p) => p !== "/nonexistent/canopy",
				probeBurrow: async () => undefined,
			},
			{},
		);
		const canopyClone = result.checks.find((c: DoctorCheck) => c.name === "canopy_clone");
		expect(canopyClone?.ok).toBe(false);
		expect(canopyClone?.message).toContain("/nonexistent/canopy");
	});

	test("returns exit 0 when every check passes", async () => {
		const { context } = captureContext({
			WARREN_API_TOKEN: "tok",
			CANOPY_REPO_URL: "https://example.com/agents.git",
		});
		const result = await runDoctor(
			context,
			{
				existsSync: () => true,
				probeBurrow: async () => undefined,
			},
			{},
		);
		expect(result.exitCode).toBe(0);
		expect(result.checks.every((c: DoctorCheck) => c.ok)).toBe(true);
	});
});
