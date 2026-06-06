import { describe, expect, test } from "bun:test";
import type { SpawnFn, SpawnResult } from "../projects/clone.ts";
import { SeedNotFoundError, SeedsCliError } from "./errors.ts";
import { showPlan, showSeed } from "./show.ts";

function ok(stdout: string): SpawnResult {
	return { stdout, stderr: "", exitCode: 0 };
}

function fail(stderr: string, exitCode = 1): SpawnResult {
	return { stdout: "", stderr, exitCode };
}

describe("showPlan", () => {
	test("shells out with the configured sd binary and project cwd", async () => {
		const calls: { cmd: readonly string[]; cwd: string }[] = [];
		const spawn: SpawnFn = async (cmd, opts) => {
			calls.push({ cmd, cwd: opts.cwd });
			return ok(
				JSON.stringify({
					success: true,
					plan: { id: "pl-acc", status: "active", children: [] },
				}),
			);
		};
		await showPlan({ spawn, sdBinary: "/opt/sd" }, "/data/projects/x/y", "pl-acc");
		expect(calls).toEqual([
			{
				cmd: ["/opt/sd", "plan", "show", "pl-acc", "--json"],
				cwd: "/data/projects/x/y",
			},
		]);
	});

	test("parses a real sd plan show envelope", async () => {
		const envelope = JSON.stringify({
			success: true,
			command: "plan show",
			plan: {
				id: "pl-a258",
				status: "active",
				revision: 1,
				template: "feature",
				children: ["warren-9990", "warren-4d7c", "warren-a3ea"],
				sections: {
					steps: [
						{ title: "Project feature flag", blocks: [6] },
						{ title: "DB schema", blocks: [5, 6] },
					],
				},
			},
		});
		const spawn: SpawnFn = async () => ok(envelope);
		const result = await showPlan({ spawn, sdBinary: "sd" }, "/p", "pl-a258");
		expect(result.id).toBe("pl-a258");
		expect(result.status).toBe("active");
		expect(result.children).toEqual(["warren-9990", "warren-4d7c", "warren-a3ea"]);
		expect(result.sections?.steps?.[0]?.blocks).toEqual([6]);
	});

	test("passthrough lets unknown plan/step/section fields ride through without failing", async () => {
		const envelope = JSON.stringify({
			success: true,
			plan: {
				id: "pl-new",
				status: "active",
				children: ["warren-1"],
				revision: 7,
				newPlanField: "future",
				sections: {
					steps: [{ title: "a", blocks: [], newStepField: { nested: true } }],
					newSectionField: 42,
				},
			},
			topLevelNewField: ["x"],
		});
		const spawn: SpawnFn = async () => ok(envelope);
		const result = await showPlan({ spawn, sdBinary: "sd" }, "/p", "pl-new");
		expect(result.id).toBe("pl-new");
		expect(result.children).toEqual(["warren-1"]);
	});

	test("throws SeedsCliError with a recoveryHint on a non-zero exit", async () => {
		const spawn: SpawnFn = async () => fail("seeds: no such plan pl-x");
		let caught: unknown;
		try {
			await showPlan({ spawn, sdBinary: "sd" }, "/p", "pl-x");
		} catch (err) {
			caught = err;
		}
		expect(caught).toBeInstanceOf(SeedsCliError);
		expect((caught as SeedsCliError).recoveryHint).toBe(
			"run `sd plan show pl-x` in /p to diagnose",
		);
	});

	test("throws SeedNotFoundError when sd reports the plan is not found", async () => {
		const spawn: SpawnFn = async () => fail("Plan not found");
		await expect(showPlan({ spawn, sdBinary: "sd" }, "/p", "pl-x")).rejects.toBeInstanceOf(
			SeedNotFoundError,
		);
	});

	test("throws SeedsCliError on non-JSON stdout", async () => {
		const spawn: SpawnFn = async () => ok("seeds: argh");
		await expect(showPlan({ spawn, sdBinary: "sd" }, "/p", "pl-x")).rejects.toBeInstanceOf(
			SeedsCliError,
		);
	});

	test("throws SeedsCliError when the envelope shape doesn't match", async () => {
		const spawn: SpawnFn = async () => ok(JSON.stringify({ success: true, plan: { id: "pl-x" } }));
		await expect(showPlan({ spawn, sdBinary: "sd" }, "/p", "pl-x")).rejects.toBeInstanceOf(
			SeedsCliError,
		);
	});
});

describe("showSeed", () => {
	test("shells out with the configured sd binary and project cwd", async () => {
		const calls: { cmd: readonly string[]; cwd: string }[] = [];
		const spawn: SpawnFn = async (cmd, opts) => {
			calls.push({ cmd, cwd: opts.cwd });
			return ok(
				JSON.stringify({
					success: true,
					issue: { id: "warren-abc", status: "open" },
				}),
			);
		};
		await showSeed({ spawn, sdBinary: "/opt/sd" }, "/data/projects/x/y", "warren-abc");
		expect(calls).toEqual([
			{
				cmd: ["/opt/sd", "show", "warren-abc", "--json"],
				cwd: "/data/projects/x/y",
			},
		]);
	});

	test("parses a real sd show envelope including blockedBy + extensions", async () => {
		const envelope = JSON.stringify({
			success: true,
			command: "show",
			issue: {
				id: "warren-2623",
				status: "open",
				title: "Coordinator",
				blockedBy: ["warren-a3ea", "warren-9e4c"],
				blocks: ["warren-f923"],
				extensions: {
					role: "claude-code",
					trigger: "manual",
					lastRunId: "run_xyz",
				},
			},
		});
		const spawn: SpawnFn = async () => ok(envelope);
		const result = await showSeed({ spawn, sdBinary: "sd" }, "/p", "warren-2623");
		expect(result.id).toBe("warren-2623");
		expect(result.status).toBe("open");
		expect(result.blockedBy).toEqual(["warren-a3ea", "warren-9e4c"]);
		expect(result.extensions?.role).toBe("claude-code");
	});

	test("parses a closed seed with no blockedBy field (passthrough tolerates omission)", async () => {
		const envelope = JSON.stringify({
			success: true,
			issue: { id: "warren-x", status: "closed", closedAt: "2026-05-18T00:00:00.000Z" },
		});
		const spawn: SpawnFn = async () => ok(envelope);
		const result = await showSeed({ spawn, sdBinary: "sd" }, "/p", "warren-x");
		expect(result.status).toBe("closed");
		expect(result.blockedBy).toBeUndefined();
	});

	test("passthrough lets unknown issue fields ride through without failing", async () => {
		const envelope = JSON.stringify({
			success: true,
			issue: {
				id: "warren-y",
				status: "open",
				newSeedsField: "future",
				extensions: { someNewKey: { nested: 1 } },
			},
		});
		const spawn: SpawnFn = async () => ok(envelope);
		const result = await showSeed({ spawn, sdBinary: "sd" }, "/p", "warren-y");
		expect(result.id).toBe("warren-y");
	});

	test("throws SeedsCliError with a recoveryHint on a non-zero exit", async () => {
		const spawn: SpawnFn = async () => fail("seeds: no such issue warren-z");
		let caught: unknown;
		try {
			await showSeed({ spawn, sdBinary: "sd" }, "/p", "warren-z");
		} catch (err) {
			caught = err;
		}
		expect(caught).toBeInstanceOf(SeedsCliError);
		expect((caught as SeedsCliError).recoveryHint).toBe("run `sd show warren-z` in /p to diagnose");
	});

	test("throws SeedNotFoundError on the real `Issue not found` message (warren-0fed)", async () => {
		const spawn: SpawnFn = async () => fail("Issue not found");
		await expect(showSeed({ spawn, sdBinary: "sd" }, "/p", "warren-z")).rejects.toBeInstanceOf(
			SeedNotFoundError,
		);
	});

	test("a transient non-zero exit stays a plain SeedsCliError, not SeedNotFoundError", async () => {
		const spawn: SpawnFn = async () => fail("database is locked");
		let caught: unknown;
		try {
			await showSeed({ spawn, sdBinary: "sd" }, "/p", "warren-z");
		} catch (err) {
			caught = err;
		}
		expect(caught).toBeInstanceOf(SeedsCliError);
		expect(caught).not.toBeInstanceOf(SeedNotFoundError);
	});

	test("throws SeedsCliError on non-JSON stdout", async () => {
		const spawn: SpawnFn = async () => ok("not json");
		await expect(showSeed({ spawn, sdBinary: "sd" }, "/p", "warren-z")).rejects.toBeInstanceOf(
			SeedsCliError,
		);
	});

	test("throws SeedsCliError when the envelope shape doesn't match", async () => {
		const spawn: SpawnFn = async () => ok(JSON.stringify({ success: true }));
		await expect(showSeed({ spawn, sdBinary: "sd" }, "/p", "warren-z")).rejects.toBeInstanceOf(
			SeedsCliError,
		);
	});
});
