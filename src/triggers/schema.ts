/**
 * Zod schemas for the seeds CLI JSON envelopes the scheduler consumes.
 *
 * Only two pieces matter for R-06:
 *   1. `sd list --format json` — pull every issue with extensions, filter
 *      down to those carrying a parseable `scheduledFor` in the past.
 *   2. `sd update <id> --extensions <json>` returns a similar issue row;
 *      we don't read the response payload today, but the schema lives here
 *      so the same parser handles both shapes when we do.
 *
 * Schemas are intentionally permissive: seeds adds extensions fields
 * regularly (plan-backrefs, scheduledFor, lastScheduledRun, …) and the
 * scheduler should not break when seeds ships a new one. We parse only
 * the fields warren needs and pass `.passthrough()` everywhere else.
 *
 * `scheduledFor` is canonical ISO 8601; we parse to a `Date` in
 * `parseScheduledSeeds` rather than carrying string-typed timestamps
 * through the dispatcher.
 */

import { z } from "zod";

const IsoDateString = z.string().min(1, "scheduledFor must be a non-empty ISO 8601 string");

const SeedExtensionsSchema = z
	.object({
		// `null` is the post-fire state (sd update --extensions writes null to
		// clear). Treat null + undefined as "not scheduled" so the filter is
		// `scheduledFor === string`.
		scheduledFor: IsoDateString.nullish(),
		lastScheduledRun: z.string().nullish(),
	})
	.passthrough();

const SeedRowSchema = z
	.object({
		id: z.string().min(1),
		status: z.string().min(1),
		title: z.string().optional(),
		extensions: SeedExtensionsSchema.optional(),
	})
	.passthrough();

export const SeedsListEnvelopeSchema = z
	.object({
		success: z.boolean().optional(),
		issues: z.array(SeedRowSchema),
	})
	.passthrough();

export type SeedRow = z.infer<typeof SeedRowSchema>;
export type SeedsListEnvelope = z.infer<typeof SeedsListEnvelopeSchema>;

export interface ScheduledSeed {
	readonly id: string;
	readonly status: string;
	readonly title?: string;
	readonly scheduledFor: Date;
}

export interface ParseScheduledSeedsResult {
	/** Open seeds with a parseable scheduledFor extension, regardless of past/future. */
	readonly scheduled: readonly ScheduledSeed[];
	/** Per-seed parse failures (bad ISO date, etc.). Surface as warnings. */
	readonly errors: readonly { readonly seedId: string; readonly message: string }[];
}

/**
 * Filter the parsed envelope down to open seeds carrying a scheduledFor
 * extension. Closed seeds are dropped — dispatching against a finished
 * issue is a no-op. The caller decides which entries are due (`<= now`)
 * versus future.
 */
export function parseScheduledSeeds(envelope: SeedsListEnvelope): ParseScheduledSeedsResult {
	const scheduled: ScheduledSeed[] = [];
	const errors: { seedId: string; message: string }[] = [];

	for (const row of envelope.issues) {
		const raw = row.extensions?.scheduledFor;
		if (raw === null || raw === undefined) continue;
		if (row.status === "closed") continue;

		const parsed = parseIsoDate(raw);
		if (parsed === null) {
			errors.push({
				seedId: row.id,
				message: `scheduledFor is not a parseable ISO 8601 timestamp: "${raw}"`,
			});
			continue;
		}
		const entry: ScheduledSeed = {
			id: row.id,
			status: row.status,
			scheduledFor: parsed,
			...(row.title !== undefined ? { title: row.title } : {}),
		};
		scheduled.push(entry);
	}

	return { scheduled, errors };
}

function parseIsoDate(raw: string): Date | null {
	const ms = Date.parse(raw);
	if (Number.isNaN(ms)) return null;
	return new Date(ms);
}
