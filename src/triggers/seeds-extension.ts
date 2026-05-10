/**
 * Shell-out facade to the seeds CLI (`sd`).
 *
 * Two operations matter for R-06:
 *
 *   `listScheduledSeeds` — `sd list --format json` against a project's
 *      .seeds/ directory, then filter to open issues with a parseable
 *      `extensions.scheduledFor`. The dispatcher decides past-vs-future.
 *
 *   `clearScheduledFor`  — `sd update <id> --extensions <json>` to move
 *      `scheduledFor → lastScheduledRun` after a successful dispatch.
 *      pl-2f15 risk #4 mitigation: the warren-side `triggers.last_fired_at`
 *      gets stamped BEFORE this call, so a failure here doesn't cause
 *      double-dispatch on the next tick (the trigger row is already
 *      consistent). Callers surface the failure as a system event on the
 *      dispatched run so the operator sees the lingering extension.
 *
 * Both shell out via the injectable `SpawnFn` shape the rest of warren
 * uses (mx-371491). The `sd` cwd is the project clone root — seeds
 * resolves `.seeds/` relative to cwd, so we never construct that path
 * ourselves.
 */

import type { SpawnFn } from "../projects/clone.ts";
import { SeedsCliError } from "./errors.ts";
import {
	type ParseScheduledSeedsResult,
	parseScheduledSeeds,
	SeedsListEnvelopeSchema,
} from "./schema.ts";

export interface SeedsCliDeps {
	readonly sdBinary: string;
	readonly spawn: SpawnFn;
	readonly timeoutMs?: number;
}

const DEFAULT_SD_TIMEOUT_MS = 30_000;

/**
 * Resolve the scheduled-for seeds for a single project. The caller (the
 * tick loop) filters down to `scheduledFor <= now` and decides what to
 * dispatch.
 */
export async function listScheduledSeeds(
	deps: SeedsCliDeps,
	projectPath: string,
): Promise<ParseScheduledSeedsResult> {
	const result = await deps.spawn([deps.sdBinary, "list", "--format", "json"], {
		cwd: projectPath,
		timeoutMs: deps.timeoutMs ?? DEFAULT_SD_TIMEOUT_MS,
	});
	if (result.exitCode !== 0) {
		throw new SeedsCliError(
			`sd list exited ${result.exitCode}: ${truncate(result.stderr || result.stdout)}`,
			{
				recoveryHint: `run \`${deps.sdBinary} doctor\` in ${projectPath} to diagnose`,
			},
		);
	}

	let parsed: unknown;
	try {
		parsed = JSON.parse(result.stdout);
	} catch (err) {
		throw new SeedsCliError(`sd list returned non-JSON output: ${formatError(err)}`, {
			cause: err,
		});
	}

	const envelope = SeedsListEnvelopeSchema.safeParse(parsed);
	if (!envelope.success) {
		throw new SeedsCliError(
			`sd list response did not match expected envelope: ${envelope.error.issues
				.map((i) => `${i.path.join(".") || "<root>"}: ${i.message}`)
				.join("; ")}`,
		);
	}

	return parseScheduledSeeds(envelope.data);
}

/**
 * Move `scheduledFor → lastScheduledRun` on a seed via the seeds CLI's
 * extension-merge surface. Seeds' shallow-merge semantics treat `null` as
 * a clear, so writing `{scheduledFor: null, lastScheduledRun: runId}` in
 * one call leaves the seed in the post-fire state.
 */
export async function clearScheduledFor(
	deps: SeedsCliDeps,
	projectPath: string,
	seedId: string,
	runId: string,
): Promise<void> {
	const extensions = JSON.stringify({ scheduledFor: null, lastScheduledRun: runId });
	const result = await deps.spawn([deps.sdBinary, "update", seedId, "--extensions", extensions], {
		cwd: projectPath,
		timeoutMs: deps.timeoutMs ?? DEFAULT_SD_TIMEOUT_MS,
	});
	if (result.exitCode !== 0) {
		throw new SeedsCliError(
			`sd update ${seedId} exited ${result.exitCode}: ${truncate(result.stderr || result.stdout)}`,
		);
	}
}

function truncate(raw: string, limit = 500): string {
	const trimmed = raw.trim();
	if (trimmed.length <= limit) return trimmed;
	return `${trimmed.slice(0, limit)}… [truncated]`;
}

function formatError(err: unknown): string {
	if (err instanceof Error) return err.message;
	return String(err);
}
