/**
 * `warren doctor` — startup health check (SPEC §8.2).
 *
 * Phase 11 wires the command shell with the checks warren can run today
 * without new infra: required env vars, burrow socket reachability via
 * `BurrowClient.probe`, and that the canopy clone exists on disk.
 *
 * Phase 13 (warren-a29f) is the dedicated wiring step that adds:
 *   - `bwrap --version` probe (sandbox bring-up readiness)
 *   - canopy "clean clone" check (no local mutations)
 *   - mirroring the same set into `/readyz`'s body
 *
 * Each check returns `{name, ok, message?, hint?}`. The command exits 0
 * when every check passes and 1 when any fails — operators wire this
 * into their boot/CI scripts.
 */

import { existsSync } from "node:fs";
import { BurrowClient } from "../../burrow-client/client.ts";
import { loadBurrowClientConfigFromEnv } from "../../burrow-client/config.ts";
import { ValidationError } from "../../core/errors.ts";
import { loadProjectsConfigFromEnv } from "../../projects/config.ts";
import { loadCanopyRegistryConfigFromEnv } from "../../registry/config.ts";
import type { CliContext, EnvLike } from "../output.ts";
import { writeJsonLine } from "../output.ts";

export interface DoctorCheck {
	readonly name: string;
	readonly ok: boolean;
	readonly message?: string;
	readonly hint?: string;
}

export interface DoctorArgs {
	readonly noAuth?: boolean;
}

export interface DoctorDeps {
	/** Override the live `BurrowClient.probe` (tests). */
	readonly probeBurrow?: (env: EnvLike) => Promise<void>;
	/** Override `existsSync` (tests). */
	readonly existsSync?: (path: string) => boolean;
}

export interface DoctorResult {
	readonly exitCode: number;
	readonly checks: readonly DoctorCheck[];
}

export async function runDoctor(
	context: CliContext,
	deps: DoctorDeps,
	args: DoctorArgs,
): Promise<DoctorResult> {
	const checks: DoctorCheck[] = [];

	checks.push(envCheck("WARREN_API_TOKEN", context.env, args.noAuth ?? false));
	checks.push(envCheck("CANOPY_REPO_URL", context.env, false));

	const canopyClone = canopyCloneCheck(context.env, deps.existsSync ?? existsSync);
	checks.push(canopyClone);

	const projectsRoot = projectsRootCheck(context.env, deps.existsSync ?? existsSync);
	checks.push(projectsRoot);

	checks.push(await burrowCheck(context.env, deps.probeBurrow));

	for (const check of checks) {
		writeJsonLine(context.stdio.stdout, check);
	}

	const allOk = checks.every((c) => c.ok);
	if (!allOk) {
		context.stdio.stderr.write("warren: one or more checks failed\n");
	}
	return { exitCode: allOk ? 0 : 1, checks };
}

function envCheck(name: string, env: EnvLike, exempted: boolean): DoctorCheck {
	if (exempted) {
		return { name, ok: true, message: "skipped (--no-auth)" };
	}
	const value = env[name];
	if (value !== undefined && value !== "") return { name, ok: true };
	return {
		name,
		ok: false,
		message: `${name} is not set`,
		hint: `export ${name}=...`,
	};
}

function canopyCloneCheck(env: EnvLike, exists: (path: string) => boolean): DoctorCheck {
	let config: ReturnType<typeof loadCanopyRegistryConfigFromEnv>;
	try {
		config = loadCanopyRegistryConfigFromEnv(env);
	} catch (err) {
		const message = err instanceof Error ? err.message : String(err);
		return {
			name: "canopy_clone",
			ok: false,
			message,
			hint: "set CANOPY_REPO_URL and (optionally) WARREN_CANOPY_DIR",
		};
	}
	if (!exists(config.localDir)) {
		return {
			name: "canopy_clone",
			ok: false,
			message: `canopy clone directory does not exist: ${config.localDir}`,
			hint: "POST /agents/refresh or run `warren register-agent <name>` to clone",
		};
	}
	return { name: "canopy_clone", ok: true, message: config.localDir };
}

function projectsRootCheck(env: EnvLike, exists: (path: string) => boolean): DoctorCheck {
	let config: ReturnType<typeof loadProjectsConfigFromEnv>;
	try {
		config = loadProjectsConfigFromEnv(env);
	} catch (err) {
		const message = err instanceof Error ? err.message : String(err);
		return { name: "projects_root", ok: false, message };
	}
	// Missing root is non-fatal — addProject will mkdirp on first use. Just
	// surface the path for visibility.
	return {
		name: "projects_root",
		ok: true,
		message: exists(config.root)
			? config.root
			: `${config.root} (will be created on first project add)`,
	};
}

async function burrowCheck(
	env: EnvLike,
	override?: (env: EnvLike) => Promise<void>,
): Promise<DoctorCheck> {
	try {
		if (override !== undefined) {
			await override(env);
		} else {
			const config = loadBurrowClientConfigFromEnv(env);
			const client = new BurrowClient({ config });
			try {
				await client.probe();
			} finally {
				await client.close().catch(() => undefined);
			}
		}
		return { name: "burrow_reachable", ok: true };
	} catch (err) {
		if (err instanceof ValidationError) {
			return {
				name: "burrow_reachable",
				ok: false,
				message: err.message,
				...(err.recoveryHint !== undefined ? { hint: err.recoveryHint } : {}),
			};
		}
		return {
			name: "burrow_reachable",
			ok: false,
			message: err instanceof Error ? err.message : String(err),
			hint: "check that burrow serve is running and WARREN_BURROW_SOCKET / WARREN_BURROW_HOST point to it",
		};
	}
}
