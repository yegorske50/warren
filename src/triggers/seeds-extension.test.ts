import { describe, expect, test } from "bun:test";
import type { SpawnFn, SpawnResult } from "../projects/clone.ts";
import { SeedsCliError } from "./errors.ts";
import { clearScheduledFor, listScheduledSeeds } from "./seeds-extension.ts";

function ok(stdout: string): SpawnResult {
	return { stdout, stderr: "", exitCode: 0 };
}

function fail(stderr: string, exitCode = 1): SpawnResult {
	return { stdout: "", stderr, exitCode };
}

describe("listScheduledSeeds", () => {
	test("shells out with the configured sd binary and project cwd", async () => {
		const calls: { cmd: readonly string[]; cwd: string }[] = [];
		const spawn: SpawnFn = async (cmd, opts) => {
			calls.push({ cmd, cwd: opts.cwd });
			return ok(JSON.stringify({ issues: [] }));
		};
		await listScheduledSeeds({ spawn, sdBinary: "/opt/sd" }, "/data/projects/x/y");
		expect(calls).toEqual([
			{ cmd: ["/opt/sd", "list", "--format", "json"], cwd: "/data/projects/x/y" },
		]);
	});

	test("parses scheduled seeds from a real sd envelope", async () => {
		const envelope = JSON.stringify({
			success: true,
			issues: [
				{
					id: "warren-a",
					status: "open",
					title: "do thing",
					extensions: { scheduledFor: "2026-05-11T00:00:00.000Z" },
				},
				{ id: "warren-b", status: "open" },
			],
		});
		const spawn: SpawnFn = async () => ok(envelope);
		const result = await listScheduledSeeds({ spawn, sdBinary: "sd" }, "/p");
		expect(result.scheduled.map((s) => s.id)).toEqual(["warren-a"]);
	});

	test("throws SeedsCliError on a non-zero exit", async () => {
		const spawn: SpawnFn = async () => fail("seeds: no .seeds/ directory");
		await expect(listScheduledSeeds({ spawn, sdBinary: "sd" }, "/p")).rejects.toBeInstanceOf(
			SeedsCliError,
		);
	});

	test("throws SeedsCliError on non-JSON stdout", async () => {
		const spawn: SpawnFn = async () => ok("seeds: argh");
		await expect(listScheduledSeeds({ spawn, sdBinary: "sd" }, "/p")).rejects.toBeInstanceOf(
			SeedsCliError,
		);
	});

	test("throws SeedsCliError when the envelope shape doesn't match", async () => {
		const spawn: SpawnFn = async () => ok(JSON.stringify({ success: true }));
		await expect(listScheduledSeeds({ spawn, sdBinary: "sd" }, "/p")).rejects.toBeInstanceOf(
			SeedsCliError,
		);
	});
});

describe("clearScheduledFor", () => {
	test("merges {scheduledFor: null, lastScheduledRun: runId} via sd update", async () => {
		const calls: { cmd: readonly string[] }[] = [];
		const spawn: SpawnFn = async (cmd) => {
			calls.push({ cmd });
			return ok("{}");
		};
		await clearScheduledFor(
			{ spawn, sdBinary: "sd" },
			"/data/projects/x/y",
			"warren-abc",
			"run_xyz",
		);
		expect(calls).toHaveLength(1);
		const cmd = calls[0]?.cmd ?? [];
		expect(cmd[0]).toBe("sd");
		expect(cmd[1]).toBe("update");
		expect(cmd[2]).toBe("warren-abc");
		expect(cmd[3]).toBe("--extensions");
		expect(JSON.parse(cmd[4] ?? "{}")).toEqual({
			scheduledFor: null,
			lastScheduledRun: "run_xyz",
		});
	});

	test("throws SeedsCliError on a non-zero exit", async () => {
		const spawn: SpawnFn = async () => fail("nope");
		await expect(
			clearScheduledFor({ spawn, sdBinary: "sd" }, "/p", "warren-abc", "run_xyz"),
		).rejects.toBeInstanceOf(SeedsCliError);
	});
});
