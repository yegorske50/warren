import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import yaml from "js-yaml";
import { openDatabase, type WarrenDb } from "../../db/client.ts";
import { AgentsRepo } from "../../db/repos/agents.ts";
import { ProjectsRepo } from "../../db/repos/projects.ts";
import { seedBuiltinAgents } from "../../registry/builtins/index.ts";
import { parseDefaultsConfig, parseTriggersConfig } from "../../warren-config/schema.ts";
import type { CliContext } from "../output.ts";
import { runInit } from "./init.ts";

function captureContext(): { context: CliContext; out: string[]; err: string[] } {
	const out: string[] = [];
	const err: string[] = [];
	return {
		context: {
			env: {},
			stdio: {
				stdout: { write: (c) => out.push(c) },
				stderr: { write: (c) => err.push(c) },
			},
			spawn: async () => ({ stdout: "", stderr: "", exitCode: 0 }),
		},
		out,
		err,
	};
}

describe("runInit (--cwd mode)", () => {
	let db: WarrenDb;
	let projects: ProjectsRepo;
	let agents: AgentsRepo;
	let tmp: string;

	beforeEach(async () => {
		db = await openDatabase({ path: ":memory:" });
		projects = new ProjectsRepo(db.drizzle);
		agents = new AgentsRepo(db.drizzle);
		tmp = await mkdtemp(join(tmpdir(), "warren-init-test-"));
	});

	afterEach(async () => {
		await db.close();
		await rm(tmp, { recursive: true, force: true });
	});

	test("scaffolds parseable triggers.yaml + defaults.json (round-trip)", async () => {
		// One agent registered → auto-fills defaultRole.
		await agents.upsert({ name: "claude-code", renderedJson: {} });
		const { context, out } = captureContext();
		const result = await runInit(context, { projects, agents }, { mode: "cwd", cwd: tmp });
		expect(result.exitCode).toBe(0);
		const stdout = JSON.parse(out.join(""));
		expect(stdout.ok).toBe(true);
		expect(stdout.scaffolded.defaultRole).toBe("claude-code");
		expect(stdout.scaffolded.files).toEqual([".warren/triggers.yaml", ".warren/defaults.json"]);

		const triggersRaw = await readFile(join(tmp, ".warren/triggers.yaml"), "utf8");
		const triggersParsed = parseTriggersConfig(yaml.load(triggersRaw));
		expect(triggersParsed.ok).toBe(true);
		if (triggersParsed.ok) expect(triggersParsed.value).toEqual([]);

		const defaultsRaw = await readFile(join(tmp, ".warren/defaults.json"), "utf8");
		const defaultsParsed = parseDefaultsConfig(JSON.parse(defaultsRaw));
		expect(defaultsParsed.ok).toBe(true);
		if (defaultsParsed.ok) expect(defaultsParsed.value).toEqual({ defaultRole: "claude-code" });
	});

	test("omits defaultRole when multiple agents are registered", async () => {
		// Mimic the real boot path — seedBuiltinAgents registers >1 agent.
		await seedBuiltinAgents(agents);
		const { context, out } = captureContext();
		const result = await runInit(context, { projects, agents }, { mode: "cwd", cwd: tmp });
		expect(result.exitCode).toBe(0);
		const defaultsRaw = await readFile(join(tmp, ".warren/defaults.json"), "utf8");
		expect(JSON.parse(defaultsRaw)).toEqual({});
		expect(JSON.parse(out.join("")).scaffolded.defaultRole).toBeNull();
	});

	test("honors --default-role when the agent exists", async () => {
		await seedBuiltinAgents(agents);
		const { context } = captureContext();
		const result = await runInit(
			context,
			{ projects, agents },
			{ mode: "cwd", cwd: tmp, defaultRole: "sapling" },
		);
		expect(result.exitCode).toBe(0);
		const defaults = JSON.parse(await readFile(join(tmp, ".warren/defaults.json"), "utf8"));
		expect(defaults.defaultRole).toBe("sapling");
	});

	test("rejects an unknown --default-role with exit 2", async () => {
		const { context, err } = captureContext();
		const result = await runInit(
			context,
			{ projects, agents },
			{ mode: "cwd", cwd: tmp, defaultRole: "nope" },
		);
		expect(result.exitCode).toBe(2);
		expect(err.join("")).toContain("unknown agent");
		expect(existsSync(join(tmp, ".warren"))).toBe(false);
	});

	test("refuses to overwrite an existing .warren/triggers.yaml", async () => {
		const { context, err } = captureContext();
		await runInit(context, { projects, agents }, { mode: "cwd", cwd: tmp });
		const { context: ctx2, err: err2 } = captureContext();
		const second = await runInit(ctx2, { projects, agents }, { mode: "cwd", cwd: tmp });
		expect(second.exitCode).toBe(2);
		expect(err2.join("")).toContain("refusing to overwrite");
		// First run shouldn't have written errors.
		expect(err.join("")).toBe("");
	});

	test("rejects a non-existent --cwd path with exit 2", async () => {
		const { context, err } = captureContext();
		const result = await runInit(
			context,
			{ projects, agents },
			{ mode: "cwd", cwd: join(tmp, "does-not-exist") },
		);
		expect(result.exitCode).toBe(2);
		expect(err.join("")).toContain("does not exist");
	});
});

describe("runInit (--project mode)", () => {
	let db: WarrenDb;
	let projects: ProjectsRepo;
	let agents: AgentsRepo;
	let tmp: string;

	beforeEach(async () => {
		db = await openDatabase({ path: ":memory:" });
		projects = new ProjectsRepo(db.drizzle);
		agents = new AgentsRepo(db.drizzle);
		tmp = await mkdtemp(join(tmpdir(), "warren-init-prj-"));
	});

	afterEach(async () => {
		await db.close();
		await rm(tmp, { recursive: true, force: true });
	});

	test("scaffolds into the project's local clone", async () => {
		await agents.upsert({ name: "claude-code", renderedJson: {} });
		const row = await projects.create({
			gitUrl: "https://github.com/example/init-target",
			localPath: tmp,
			defaultBranch: "main",
		});
		const { context } = captureContext();
		const result = await runInit(
			context,
			{ projects, agents },
			{ mode: "project", projectId: row.id },
		);
		expect(result.exitCode).toBe(0);
		expect(existsSync(join(tmp, ".warren/triggers.yaml"))).toBe(true);
		expect(existsSync(join(tmp, ".warren/defaults.json"))).toBe(true);
	});

	test("rejects an unknown project id with exit 1", async () => {
		const { context, err } = captureContext();
		const result = await runInit(
			context,
			{ projects, agents },
			{ mode: "project", projectId: "prj_missing" },
		);
		expect(result.exitCode).toBe(1);
		expect(err.join("")).toContain("project not found");
	});

	test("rejects a project whose clone is missing on disk with exit 2", async () => {
		const missing = join(tmp, "vanished");
		const row = await projects.create({
			gitUrl: "https://github.com/example/vanished",
			localPath: missing,
			defaultBranch: "main",
		});
		const { context, err } = captureContext();
		const result = await runInit(
			context,
			{ projects, agents },
			{ mode: "project", projectId: row.id },
		);
		expect(result.exitCode).toBe(2);
		expect(err.join("")).toContain("missing on disk");
	});
});
