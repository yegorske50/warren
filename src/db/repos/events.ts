/**
 * Repository for the `events` table.
 *
 * Warren's events table is a write-through cache of burrow's stream (SPEC
 * §9). Each row carries the burrow-side `seq` so we can resume the stream
 * at MAX(burrow_event_seq) + 1 after a warren restart mid-run, and so the UI
 * replays events in the same order burrow emitted them.
 */

import { and, asc, desc, eq, gt, sql } from "drizzle-orm";
import type { DrizzleDb } from "../client.ts";
import { type EventRow, type EventStream, events } from "../schema.ts";

export interface AppendEventInput {
	runId: string;
	burrowEventSeq: number;
	ts: string;
	kind: string;
	stream?: EventStream | null;
	payload: unknown;
}

export class EventsRepo {
	constructor(private readonly db: DrizzleDb) {}

	append(input: AppendEventInput): EventRow {
		return this.db
			.insert(events)
			.values({
				runId: input.runId,
				burrowEventSeq: input.burrowEventSeq,
				ts: input.ts,
				kind: input.kind,
				stream: input.stream ?? null,
				payloadJson: input.payload,
			})
			.returning()
			.get();
	}

	listByRun(runId: string, opts: { sinceSeq?: number; limit?: number } = {}): EventRow[] {
		const where =
			opts.sinceSeq !== undefined
				? and(eq(events.runId, runId), gt(events.burrowEventSeq, opts.sinceSeq))
				: eq(events.runId, runId);
		const q = this.db.select().from(events).where(where).orderBy(asc(events.burrowEventSeq));
		return opts.limit ? q.limit(opts.limit).all() : q.all();
	}

	/**
	 * Last N events for a run, returned in ascending seq order (oldest-first
	 * within the window). Powers the UI's "tail buffer" — `listByRun({limit})`
	 * returns the FIRST N which is the wrong end for live tail.
	 */
	listTail(runId: string, limit: number): EventRow[] {
		if (limit <= 0) return [];
		const rows = this.db
			.select()
			.from(events)
			.where(eq(events.runId, runId))
			.orderBy(desc(events.burrowEventSeq))
			.limit(limit)
			.all();
		return rows.reverse();
	}

	/**
	 * Highest burrow_event_seq we've persisted for a run, or null if none.
	 * Used at warren startup to compute the resume offset for live runs
	 * (SPEC §9 "MAX(events.burrow_event_seq) + 1").
	 */
	maxSeqForRun(runId: string): number | null {
		const row = this.db
			.select({ max: sql<number | null>`max(${events.burrowEventSeq})` })
			.from(events)
			.where(eq(events.runId, runId))
			.get();
		return row?.max ?? null;
	}

	countByRun(runId: string): number {
		const row = this.db
			.select({ n: sql<number>`count(*)` })
			.from(events)
			.where(eq(events.runId, runId))
			.get();
		return row?.n ?? 0;
	}
}
