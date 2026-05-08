import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { openDatabase, type WarrenDb } from "../client.ts";
import { AgentsRepo } from "./agents.ts";
import { EventsRepo } from "./events.ts";
import { ProjectsRepo } from "./projects.ts";
import { RunsRepo } from "./runs.ts";

describe("EventsRepo", () => {
	let db: WarrenDb;
	let events: EventsRepo;
	let runId: string;

	beforeEach(async () => {
		db = await openDatabase({ path: ":memory:" });
		const agents = new AgentsRepo(db.drizzle);
		const projects = new ProjectsRepo(db.drizzle);
		const runs = new RunsRepo(db.drizzle);
		agents.upsert({ name: "refactor-bot", renderedJson: {} });
		const project = projects.create({
			gitUrl: "https://github.com/x/y.git",
			localPath: "/data/projects/x/y",
			defaultBranch: "main",
		});
		const run = runs.create({
			agentName: "refactor-bot",
			projectId: project.id,
			prompt: "x",
			renderedAgentJson: {},
			trigger: "manual",
		});
		runId = run.id;
		events = new EventsRepo(db.drizzle);
	});

	afterEach(() => {
		db.close();
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

	test("append returns the inserted row with an autoincrement id and parsed payload", () => {
		const row = append(1);
		expect(row.id).toBeGreaterThan(0);
		expect(row.runId).toBe(runId);
		expect(row.burrowEventSeq).toBe(1);
		expect(row.payloadJson).toEqual({ seq: 1 });
	});

	test("listByRun returns events ordered by burrow_event_seq", () => {
		append(3);
		append(1);
		append(2);
		const got = events.listByRun(runId).map((e) => e.burrowEventSeq);
		expect(got).toEqual([1, 2, 3]);
	});

	test("listByRun({ sinceSeq }) excludes events at or below the cursor", () => {
		append(1);
		append(2);
		append(3);
		const got = events.listByRun(runId, { sinceSeq: 1 }).map((e) => e.burrowEventSeq);
		expect(got).toEqual([2, 3]);
	});

	test("listByRun({ limit }) caps the page size", () => {
		for (let i = 1; i <= 10; i++) append(i);
		expect(events.listByRun(runId, { limit: 3 }).map((e) => e.burrowEventSeq)).toEqual([1, 2, 3]);
	});

	test("listTail returns the last N in seq-ascending order", () => {
		for (let i = 1; i <= 5; i++) append(i);
		expect(events.listTail(runId, 2).map((e) => e.burrowEventSeq)).toEqual([4, 5]);
	});

	test("listTail with limit <= 0 returns []", () => {
		append(1);
		expect(events.listTail(runId, 0)).toEqual([]);
		expect(events.listTail(runId, -1)).toEqual([]);
	});

	test("maxSeqForRun returns null when no events exist, else the max seq", () => {
		expect(events.maxSeqForRun(runId)).toBeNull();
		append(1);
		append(7);
		append(3);
		expect(events.maxSeqForRun(runId)).toBe(7);
	});

	test("countByRun reports the row count", () => {
		expect(events.countByRun(runId)).toBe(0);
		append(1);
		append(2);
		expect(events.countByRun(runId)).toBe(2);
	});

	test("nullable stream column round-trips as null", () => {
		const row = events.append({
			runId,
			burrowEventSeq: 1,
			ts: "2026-05-08T12:00:00.000Z",
			kind: "system",
			payload: {},
		});
		expect(row.stream).toBeNull();
	});
});
