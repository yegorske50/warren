import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { openDatabase, type WarrenDb } from "../client.ts";
import { AgentsRepo } from "./agents.ts";
import { DrizzleAdapter } from "./drizzle-adapter.ts";
import { EventsRepo } from "./events.ts";
import { ProjectsRepo } from "./projects.ts";
import { RunsRepo } from "./runs.ts";

describe("EventsRepo", () => {
	let db: WarrenDb;
	let events: EventsRepo;
	let runId: string;

	beforeEach(async () => {
		db = await openDatabase({ path: ":memory:" });
		const agents = new AgentsRepo(DrizzleAdapter.for(db));
		const projects = new ProjectsRepo(db.drizzle);
		const runs = new RunsRepo(db.drizzle);
		await agents.upsert({ name: "refactor-bot", renderedJson: {} });
		const project = await projects.create({
			gitUrl: "https://github.com/x/y.git",
			localPath: "/data/projects/x/y",
			defaultBranch: "main",
		});
		const run = await runs.create({
			agentName: "refactor-bot",
			projectId: project.id,
			prompt: "x",
			renderedAgentJson: {},
			trigger: "manual",
		});
		runId = run.id;
		events = new EventsRepo(db.drizzle);
	});

	afterEach(async () => {
		await db.close();
	});

	function append(seq: number, kind = "text", stream: "stdout" | "stderr" | "system" = "stdout") {
		return events.append({
			runId,
			burrowEventSeq: seq,
			ts: new Date(2026, 4, 8, 12, 0, seq).toISOString(),
			kind,
			stream,
			payload: { seq },
		});
	}

	test("append returns the inserted row with an autoincrement id and parsed payload", async () => {
		const row = await append(1);
		expect(row.id).toBeGreaterThan(0);
		expect(row.runId).toBe(runId);
		expect(row.burrowEventSeq).toBe(1);
		expect(row.payloadJson).toEqual({ seq: 1 });
	});

	test("listByRun returns events ordered by burrow_event_seq", async () => {
		await append(3);
		await append(1);
		await append(2);
		const got = (await events.listByRun(runId)).map((e) => e.burrowEventSeq);
		expect(got).toEqual([1, 2, 3]);
	});

	test("listByRun({ sinceSeq }) excludes events at or below the cursor", async () => {
		await append(1);
		await append(2);
		await append(3);
		const got = (await events.listByRun(runId, { sinceSeq: 1 })).map((e) => e.burrowEventSeq);
		expect(got).toEqual([2, 3]);
	});

	test("listByRun({ limit }) caps the page size", async () => {
		for (let i = 1; i <= 10; i++) await append(i);
		expect((await events.listByRun(runId, { limit: 3 })).map((e) => e.burrowEventSeq)).toEqual([
			1, 2, 3,
		]);
	});

	test("listTail returns the last N in seq-ascending order", async () => {
		for (let i = 1; i <= 5; i++) await append(i);
		expect((await events.listTail(runId, 2)).map((e) => e.burrowEventSeq)).toEqual([4, 5]);
	});

	test("listTail with limit <= 0 returns []", async () => {
		await append(1);
		expect(await events.listTail(runId, 0)).toEqual([]);
		expect(await events.listTail(runId, -1)).toEqual([]);
	});

	test("maxSeqForRun returns null when no events exist, else the max seq", async () => {
		expect(await events.maxSeqForRun(runId)).toBeNull();
		await append(1);
		await append(7);
		await append(3);
		expect(await events.maxSeqForRun(runId)).toBe(7);
	});

	test("countByRun reports the row count", async () => {
		expect(await events.countByRun(runId)).toBe(0);
		await append(1);
		await append(2);
		expect(await events.countByRun(runId)).toBe(2);
	});

	test("nullable stream column round-trips as null", async () => {
		const row = await events.append({
			runId,
			burrowEventSeq: 1,
			ts: "2026-05-08T12:00:00.000Z",
			kind: "system",
			payload: {},
		});
		expect(row.stream).toBeNull();
	});
});
