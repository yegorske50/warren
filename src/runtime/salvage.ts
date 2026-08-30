/**
 * Salvage-before-destroy (warren-cd3b) — the shared vocabulary for recovering a
 * run's committed work when the normal finalize branch push never landed.
 *
 * The defect: a reap whose `branch_push` stage failed (or whose in-pod finalize
 * never posted a result) used to leave the agent's commits stranded on a
 * workspace that was then destroyed — or, under K8s, "preserved" as a no-op
 * skip while the pod's `emptyDir` died with the container. Salvage runs BEFORE
 * destroy and captures the work two ways, either of which an operator can
 * recover from:
 *
 *   1. RESCUE REF — a best-effort `git push origin HEAD:<rescueBranch>` onto a
 *      per-run branch (`warren/rescue/<runId>`). Cheapest to recover
 *      (`git fetch origin warren/rescue/<runId>`), but it rides the same push
 *      path that just failed, so it can be rejected too (e.g. GitHub push
 *      protection scanning the same history).
 *   2. BUNDLE — a `git bundle` of the run's commits captured to durable
 *      warren-side storage (`<dataDir>/salvage/<runId>.bundle`). Under K8s the
 *      POD builds and POSTs the bundle over the authenticated callback (the
 *      control plane cannot reach the pod's volume); under LocalProvider reap
 *      writes it host-side. Recover with `git bundle unbundle` / `git fetch
 *      <file> HEAD`.
 *
 * Who runs what (the runtime split):
 *   - LocalProvider: reap has host-side workspace access, so the salvage step
 *     lives in `src/runs/reap/salvage.ts` and runs between finalize and
 *     `runWorkspaceDestroy`.
 *   - K8sProvider: only the pod can see its workspace, so the salvage runs
 *     INSIDE the pod (`src/runtime/k8s/salvage.ts`, driven by
 *     `finalize-entrypoint.ts`) before the container exits, and the bundle
 *     rides `POST /runs/:id/salvage` to warren-side durable storage.
 *
 * The outcome is surfaced on the run row (`salvage_ref` / `salvage_path`) and
 * as `reap.workspace_salvaged` / `reap.workspace_salvage_failed` run events.
 */

import { resolve, sep } from "node:path";
import { ValidationError } from "../core/errors.ts";

/** Prefix for the per-run rescue branch pushed to the project's origin. */
export const RESCUE_BRANCH_PREFIX = "warren/rescue/";

/** The per-run rescue branch name on origin (`warren/rescue/<runId>`). */
export function rescueBranchFor(runId: string): string {
	return `${RESCUE_BRANCH_PREFIX}${runId}`;
}

/** The warren-side durable file name for a salvaged bundle (`<runId>.bundle`). */
export function salvageBundleFileName(runId: string): string {
	return `${runId}.bundle`;
}

/**
 * Charset a run id may use once it is about to become a file name
 * (warren-7c1e). Generated ids are `run_<base32>` so this is deliberately
 * loose relative to `isId("run", …)` — fixtures and older rows use other
 * shapes — but tight enough that the value cannot express a path segment.
 */
const FILE_SAFE_RUN_ID = /^[A-Za-z0-9_.-]+$/;

/**
 * Resolve the durable bundle path for `runId` under `salvageDir`, refusing
 * anything that would land outside it.
 *
 * `POST /runs/:id/salvage` reaches here with a route param, and the router
 * percent-decodes params — so before warren-7c1e a request for
 * `/runs/..%2F..%2Fetc%2Fpwn/salvage` decoded to `../../etc/pwn` and this
 * join wrote 32 MiB of caller-supplied bytes wherever it pointed. The
 * router now refuses separators in a param; this is the second lock on the
 * same door, at the sink rather than the source, so a future caller that
 * reaches the store from somewhere other than a route (a CLI flag, a
 * queue) inherits the check instead of re-deriving it.
 *
 * Rejects: a relative/absolute-looking or dot-bearing id (`FILE_SAFE_RUN_ID`),
 * and — belt and braces — any resolved target that is not a direct child of
 * the resolved `salvageDir`.
 */
export function salvageBundlePath(salvageDir: string, runId: string): string {
	if (!FILE_SAFE_RUN_ID.test(runId) || runId === "." || runId === "..") {
		throw new ValidationError(
			`run id ${JSON.stringify(runId)} is not usable as a salvage file name`,
			{ recoveryHint: "a run id may contain only letters, digits, '.', '_' and '-'" },
		);
	}
	const root = resolve(salvageDir);
	const target = resolve(root, salvageBundleFileName(runId));
	if (!target.startsWith(root + sep)) {
		throw new ValidationError(`salvage bundle path for run ${runId} escapes the salvage directory`);
	}
	return target;
}

/**
 * Cap on a captured bundle (raw bytes). The bundle rides a JSON POST as base64
 * under K8s, so this also bounds the callback payload (~1.37x). A run branch
 * holding more than 32MiB of commits-ahead is salvage-by-rescue-ref-or-bust —
 * the failure is surfaced in `notes` rather than silently truncated.
 */
export const MAX_SALVAGE_BUNDLE_BYTES = 32 * 1024 * 1024;

/** What a salvage attempt managed to capture. Both null ⇒ nothing was saved. */
export interface SalvageCapture {
	/** The rescue branch on origin, when the rescue push landed. */
	readonly rescueRef: string | null;
	/** The bundle payload (raw bytes host-side; base64 on the pod→warren wire). */
	readonly bundlePath: string | null;
}
