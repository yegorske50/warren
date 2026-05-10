import { describe, expect, test } from "bun:test";
import { parseScheduledSeeds, SeedsListEnvelopeSchema } from "./schema.ts";

const ENVELOPE = {
	success: true,
	issues: [
		{
			id: "warren-a",
			status: "open",
			title: "do thing",
			extensions: { scheduledFor: "2026-05-11T00:00:00.000Z" },
		},
		{
			id: "warren-b",
			status: "open",
			extensions: { scheduledFor: null },
		},
		{
			id: "warren-c",
			status: "closed",
			extensions: { scheduledFor: "2026-05-11T00:00:00.000Z" },
		},
		{
			id: "warren-d",
			status: "in_progress",
			extensions: { scheduledFor: "not-a-date" },
		},
		{
			id: "warren-e",
			status: "open",
		},
	],
};

describe("SeedsListEnvelopeSchema", () => {
	test("parses real sd list shape (unknown fields pass through)", () => {
		const parsed = SeedsListEnvelopeSchema.safeParse(ENVELOPE);
		expect(parsed.success).toBe(true);
	});

	test("rejects an envelope with no issues array", () => {
		const parsed = SeedsListEnvelopeSchema.safeParse({ success: true });
		expect(parsed.success).toBe(false);
	});
});

describe("parseScheduledSeeds", () => {
	test("returns only open seeds with a parseable scheduledFor", () => {
		const envelope = SeedsListEnvelopeSchema.parse(ENVELOPE);
		const result = parseScheduledSeeds(envelope);
		const ids = result.scheduled.map((s) => s.id);
		expect(ids).toEqual(["warren-a"]);
		expect(result.scheduled[0]?.scheduledFor.toISOString()).toBe("2026-05-11T00:00:00.000Z");
		expect(result.scheduled[0]?.title).toBe("do thing");
	});

	test("captures malformed scheduledFor strings as per-seed errors", () => {
		const envelope = SeedsListEnvelopeSchema.parse(ENVELOPE);
		const result = parseScheduledSeeds(envelope);
		expect(result.errors).toEqual([
			{
				seedId: "warren-d",
				message: 'scheduledFor is not a parseable ISO 8601 timestamp: "not-a-date"',
			},
		]);
	});

	test("drops closed seeds even when scheduledFor parses", () => {
		const envelope = SeedsListEnvelopeSchema.parse({
			issues: [
				{
					id: "warren-c",
					status: "closed",
					extensions: { scheduledFor: "2026-05-11T00:00:00.000Z" },
				},
			],
		});
		const result = parseScheduledSeeds(envelope);
		expect(result.scheduled).toEqual([]);
	});
});
