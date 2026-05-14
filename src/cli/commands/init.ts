/**
 * `warren init` — scaffold a `.warren/` directory inside a project repo
 * (warren-bd22, R-02 producer-side affordance).
 *
 * Today the `.warren/` convention is purely loader-side: warren reads
 * `.warren/triggers.yaml` and `.warren/defaults.json` from a project clone
 * but offers no help producing them. This command closes that gap by
 * writing a canonical, schema-valid skeleton:
 *
 *   `.warren/triggers.yaml`  empty list with a comment header
 *   `.warren/defaults.json`  `{ "defaultRole": <name> }` (or `{}`)
 *
 * Two target modes:
 *
 *   `--cwd` (default)    scaffolds into the operator's current working
 *                        directory — used when the operator has the
 *                        project repo checked out somewhere and will
 *                        commit + push themselves.
 *   `--project <id>`     scaffolds into the warren clone at
 *                        `<projects-root>/.../<repo>`. Useful for
 *                        warren-on-warren and other in-container flows;
 *                        operator still owns the commit + push (e.g. via
 *                        the project repo upstream).
 *
 * No git side-effects: this is intentionally a write-and-stop. The
 * heavier UI variant (B) in warren-bd22 — commit + push from warren's
 * service identity — is deferred until warren has a sanctioned
 * project-repo write path beyond `git push` from reap.
 *
 * Refuses to overwrite either file. Schema is enforced at scaffold time
 * via `parseDefaultsConfig` so a malformed defaults blob is impossible
 * to write.
 */

import { existsSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { isAbsolute, join, resolve } from "node:path";
import { NotFoundError, ValidationError } from "../../core/errors.ts";
import type { AgentsRepo } from "../../db/repos/agents.ts";
import type { ProjectsRepo } from "../../db/repos/projects.ts";
import {
	WARREN_CONFIG_DIR,
	WARREN_CONFIG_FILES,
	warrenConfigRelativePath,
} from "../../warren-config/config.ts";
import { type DefaultsConfig, parseDefaultsConfig } from "../../warren-config/schema.ts";
import type { CliContext } from "../output.ts";
import { formatError, writeJsonLine } from "../output.ts";

export type InitArgs =
	| {
			readonly mode: "cwd";
			readonly cwd: string;
			readonly defaultRole?: string;
	  }
	| {
			readonly mode: "project";
			readonly projectId: string;
			readonly defaultRole?: string;
	  };

export interface InitDeps {
	readonly projects: ProjectsRepo;
	readonly agents: AgentsRepo;
}

export interface InitResult {
	readonly exitCode: number;
}

/**
 * Canonical header for the empty triggers.yaml — short enough to read at
 * a glance, long enough to point operators at the schema. Keep this in
 * lockstep with `src/warren-config/schema.ts` if/when new trigger kinds
 * ship.
 */
const TRIGGERS_TEMPLATE = `# .warren/triggers.yaml — scheduled runs for this project (R-06).
#
# Each entry is a cron-style trigger. Warren ticks once a minute and
# spawns a run when a trigger is due. See SPEC §11.I for the contract.
#
# Example:
# - id: nightly-housekeeping
#   kind: cron
#   cron: '0 3 * * *'      # 03:00 daily (5 or 6 whitespace-separated fields)
#   seed: warren-housekeep # seed id the agent reads + writes
#   role: claude-code      # registered agent name
#   timezone: UTC          # optional; default UTC
#   prompt: |              # optional; pre-filled into the agent
#     Run the housekeeping checklist.
[]
`;

export async function runInit(
	context: CliContext,
	deps: InitDeps,
	args: InitArgs,
): Promise<InitResult> {
	try {
		const targetDir = await resolveTargetDir(deps, args);
		const warrenDir = join(targetDir, WARREN_CONFIG_DIR);
		const triggersAbs = join(warrenDir, WARREN_CONFIG_FILES.triggers);
		const defaultsAbs = join(warrenDir, WARREN_CONFIG_FILES.defaults);

		if (existsSync(triggersAbs)) {
			throw new ValidationError(
				`refusing to overwrite existing ${warrenConfigRelativePath("triggers")} at ${triggersAbs}`,
				{ recoveryHint: "edit the existing file by hand" },
			);
		}
		if (existsSync(defaultsAbs)) {
			throw new ValidationError(
				`refusing to overwrite existing ${warrenConfigRelativePath("defaults")} at ${defaultsAbs}`,
				{ recoveryHint: "edit the existing file by hand" },
			);
		}

		const defaults = await resolveDefaults(deps, args);
		const defaultsJson = `${JSON.stringify(defaults, null, 2)}\n`;

		await mkdir(warrenDir, { recursive: true });
		await writeFile(triggersAbs, TRIGGERS_TEMPLATE, "utf8");
		await writeFile(defaultsAbs, defaultsJson, "utf8");

		writeJsonLine(context.stdio.stdout, {
			ok: true,
			scaffolded: {
				root: targetDir,
				files: [warrenConfigRelativePath("triggers"), warrenConfigRelativePath("defaults")],
				defaultRole: defaults.defaultRole ?? null,
			},
		});
		return { exitCode: 0 };
	} catch (err) {
		context.stdio.stderr.write(`warren: ${formatError(err)}\n`);
		return { exitCode: err instanceof ValidationError ? 2 : 1 };
	}
}

async function resolveTargetDir(deps: InitDeps, args: InitArgs): Promise<string> {
	if (args.mode === "cwd") {
		const cwd = args.cwd;
		if (cwd === "") {
			throw new ValidationError("--cwd path is empty");
		}
		const abs = isAbsolute(cwd) ? cwd : resolve(cwd);
		if (!existsSync(abs)) {
			throw new ValidationError(`target directory does not exist: ${abs}`);
		}
		return abs;
	}
	const row = await deps.projects.get(args.projectId);
	if (row === null) {
		throw new NotFoundError(`project not found: ${args.projectId}`);
	}
	if (!existsSync(row.localPath)) {
		throw new ValidationError(`project clone missing on disk: ${row.localPath}`, {
			recoveryHint: "POST /projects/:id/refresh or re-add the project",
		});
	}
	return row.localPath;
}

async function resolveDefaults(deps: InitDeps, args: InitArgs): Promise<DefaultsConfig> {
	const candidate: Record<string, string> = {};
	const explicit = args.defaultRole;
	if (explicit !== undefined && explicit !== "") {
		const agent = await deps.agents.get(explicit);
		if (agent === null) {
			throw new ValidationError(`unknown agent: ${explicit}`, {
				recoveryHint: "run `warren register-agent <name>` first, or omit --default-role",
			});
		}
		candidate.defaultRole = explicit;
	} else {
		// No explicit pick — auto-fill only when there's exactly one agent
		// registered. Multiple agents and we leave the field blank so the
		// operator picks at edit time (the schema accepts empty defaults).
		const agents = await deps.agents.listAll();
		if (agents.length === 1) {
			const only = agents[0];
			if (only !== undefined) {
				candidate.defaultRole = only.name;
			}
		}
	}

	const parsed = parseDefaultsConfig(candidate);
	if (!parsed.ok) {
		// Should not happen — we only put fields the schema knows about —
		// but if it does, surface the schema message verbatim.
		throw new ValidationError(`defaults.json failed schema validation: ${parsed.message}`);
	}
	return parsed.value;
}
