/**
 * Resolve the PlanRun coordinator's environment-driven config (warren-2623).
 *
 * Env contract:
 *   WARREN_PLAN_RUN_TICK_MS   tick interval in ms — default 10_000 (10s),
 *                              faster than the cron scheduler (60s) because
 *                              plan progression is the operator's
 *                              interactive loop.
 *   WARREN_PLAN_RUN_DISABLED  disable the coordinator entirely — same
 *                              truthy set as WARREN_SCHEDULER_DISABLED
 *                              ("1"/"true"/"yes"/"on", case-insensitive).
 */

import { ValidationError } from "../core/errors.ts";

export const DEFAULT_PLAN_RUN_TICK_MS = 10_000;

export interface PlanRunCoordinatorConfig {
	readonly tickMs: number;
	readonly disabled: boolean;
}

export type EnvLike = Readonly<Record<string, string | undefined>>;

export function loadPlanRunCoordinatorConfigFromEnv(
	env: EnvLike = process.env,
): PlanRunCoordinatorConfig {
	return {
		tickMs: parseTickMs(env.WARREN_PLAN_RUN_TICK_MS),
		disabled: parseBoolFlag(env.WARREN_PLAN_RUN_DISABLED),
	};
}

function parseTickMs(raw: string | undefined): number {
	if (raw === undefined || raw === "") return DEFAULT_PLAN_RUN_TICK_MS;
	const parsed = Number(raw);
	if (!Number.isFinite(parsed) || parsed <= 0) {
		throw new ValidationError(`WARREN_PLAN_RUN_TICK_MS must be a positive integer, got "${raw}"`, {
			recoveryHint: `unset or set to a positive integer (default ${DEFAULT_PLAN_RUN_TICK_MS})`,
		});
	}
	return Math.trunc(parsed);
}

function parseBoolFlag(raw: string | undefined): boolean {
	if (raw === undefined) return false;
	const normalized = raw.trim().toLowerCase();
	if (normalized === "") return false;
	return !["0", "false", "no", "off"].includes(normalized);
}
