import { execFile } from "node:child_process";
import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { promisify } from "node:util";
import type { RunRow, RunTerminalState } from "../../db/schema.ts";
import type { ReapExec, ReapFs, ReapRunResult } from "./types.ts";

const execFileAsync = promisify(execFile);

/**
 * The no-op `ReapRunResult` returned when `reapRun` is invoked against a
 * row that is already terminal (idempotent re-reap). Preserves the
 * already-persisted preview lifecycle (`live`/`failed`) and PR url; every
 * sub-step counter reports zero because no work was done.
 */
export function buildAlreadyTerminalResult(run: RunRow): ReapRunResult {
	const idempotentPreviewState =
		run.previewState === "live" || run.previewState === "failed" ? run.previewState : null;
	return {
		state: run.state as RunTerminalState,
		failureReason: run.failureReason,
		mulchUpdated: 0,
		mulchSkipped: 0,
		mulchAppended: 0,
		seedsClosed: 0,
		seedsCreated: 0,
		plotEventsAppended: 0,
		plotsUpdated: 0,
		plotEventsMirrored: 0,
		plotCommitted: false,
		seedsCommitted: false,
		branchPushed: false,
		commitsAhead: null,
		prUrl: run.prUrl,
		previewState: idempotentPreviewState,
		previewPort: run.previewPort,
		previewUrl: null,
		autoPlanRunCreated: false,
		autoPlanRunId: null,
		autoPlanRunPlanId: null,
		workspaceDestroyed: false,
		errors: [],
		alreadyTerminal: true,
	};
}

export function splitLines(body: string): string[] {
	const out: string[] = [];
	for (const raw of body.split("\n")) {
		const trimmed = raw.trim();
		if (trimmed === "") continue;
		out.push(trimmed);
	}
	return out;
}

export function createSeqAllocator(start: number): { next: () => number } {
	let cur = start;
	return {
		next: () => {
			cur += 1;
			return cur;
		},
	};
}

export function isEnoent(err: unknown): boolean {
	return typeof err === "object" && err !== null && (err as { code?: unknown }).code === "ENOENT";
}

export const defaultFs: ReapFs = {
	mkdirp: async (path) => {
		await mkdir(path, { recursive: true });
	},
	readFile: async (path) => {
		try {
			return await readFile(path, "utf8");
		} catch (err) {
			if (isEnoent(err)) return null;
			throw err;
		}
	},
	writeFile: async (path, contents) => {
		await writeFile(path, contents);
	},
	readdir: async (path) => {
		try {
			return await readdir(path);
		} catch (err) {
			if (isEnoent(err)) return [];
			throw err;
		}
	},
};

export const defaultExec: ReapExec = {
	run: async (cmd, args, opts) => {
		const execOpts: { cwd: string; timeout?: number } = { cwd: opts.cwd };
		if (opts.timeoutMs !== undefined) execOpts.timeout = opts.timeoutMs;
		const { stdout, stderr } = await execFileAsync(cmd, [...args], execOpts);
		return { stdout, stderr };
	},
};
