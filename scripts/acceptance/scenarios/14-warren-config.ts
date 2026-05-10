/**
 * Scenario 14 — `.warren/` config envelope across the three lifecycle
 * states (R-02, pl-5d74 step 7).
 *
 * Acceptance criterion #5 of pl-5d74:
 *   "warren doctor and /readyz include a .warren/ validation check
 *   covering all three states (absent, valid, malformed)."
 *
 * Walks one project through the same pipeline an operator would
 * touch — the source repo gets edits, warren picks them up via
 * `POST /projects/:id/refresh`, and we assert the contract on both
 * the per-project endpoint (`GET /projects/:id/warren-config`) and
 * the host-wide readyz check (`warren_config` entry in
 * `GET /readyz` `.checks[]`). Doctor and readyz share the same
 * `checkWarrenConfig` function (mx-718b25), so the readyz assertions
 * cover the doctor surface too without spawning a child process.
 *
 * State 1 — absent:
 *   The fixture sample project ships without a `.warren/` directory,
 *   so the very first GET must report null/null/[] and the readyz
 *   check must report `ok: true` with the "no .warren/ failures"
 *   message (the "absent is bootstrap" branch in src/warren-config/load.ts).
 *
 * State 2 — valid:
 *   Write canonical `.warren/triggers.yaml` + `.warren/defaults.json` into
 *   the source repo, commit, refresh. The endpoint returns parsed values
 *   (with the cron + role we wrote) and `errors=[]`; the readyz check is
 *   still ok.
 *
 * State 3 — malformed:
 *   Overwrite both files with broken content (schema-invalid YAML +
 *   non-JSON), commit, refresh. The endpoint returns
 *   `triggers=null, defaults=null, errors=[…]` with one
 *   `warren_config_schema_error` and one `warren_config_parse_error` — and
 *   the readyz check flips to `ok: false` with a hint mentioning
 *   `.warren/`.
 *
 * Cache-invalidation note: refreshProject invalidates the
 * `WarrenConfigCache` entry BEFORE recordRefresh writes (mx-66d478, risk
 * #4 in pl-5d74), so each transition between states is observable on the
 * very next GET — no stale envelope from the previous state lingers.
 *
 * Mode: in-proc only. Container mode does not bind-mount the host sample
 * project (mx-96d833), so we have no way to drive the source-repo edits
 * from outside the container. The contract is the same in both modes —
 * readyz uses the same shared check function inside the container — so
 * in-proc coverage is sufficient (mirrors scenario 03's rationale).
 */

import { existsSync } from "node:fs";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { AcceptanceError, assertEqual, assertTrue, type Scenario } from "../lib/assert.ts";
import { WarrenHttp } from "../lib/http.ts";

interface ProjectRow {
	readonly id: string;
	readonly gitUrl: string;
	readonly localPath: string;
	readonly defaultBranch: string;
}

interface RefreshResponse {
	readonly project: ProjectRow;
	readonly headSha: string;
	readonly ref: string;
}

interface WarrenConfigFileError {
	readonly file: string;
	readonly code: string;
	readonly message: string;
}

interface WarrenConfigResponse {
	readonly triggers: ReadonlyArray<{
		readonly id: string;
		readonly kind: string;
		readonly cron: string;
		readonly seed: string;
		readonly role: string;
	}> | null;
	readonly defaults: {
		readonly defaultBranch?: string;
		readonly defaultRole?: string;
		readonly defaultPrompt?: string;
	} | null;
	readonly errors: readonly WarrenConfigFileError[];
}

interface ReadyzCheck {
	readonly name: string;
	readonly ok: boolean;
	readonly message?: string;
	readonly hint?: string;
}

interface ReadyzResponse {
	readonly ok: boolean;
	readonly checks: readonly ReadyzCheck[];
}

const TRIGGER_ID = "scenario-14-nightly";
const TRIGGER_CRON = "0 3 * * *";
const TRIGGER_SEED = "warren-scenario-14";
const TRIGGER_ROLE = "claude-code";
const DEFAULT_BRANCH = "main";
const DEFAULT_ROLE = "claude-code";

export const scenario: Scenario = {
	id: "14",
	title: ".warren/ config — absent → valid → malformed walks readyz + endpoint contract",
	modes: ["in-proc"],
	async run(ctx) {
		const http = new WarrenHttp({ baseUrl: ctx.warrenUrl, token: ctx.token });

		const project = await ensureSampleProject(http, ctx.fixtures.sampleProjectGitUrl);
		const warrenDirInSource = join(ctx.fixtures.sampleProjectPath, ".warren");
		const warrenDirInClone = join(project.localPath, ".warren");

		// Other scenarios may have run first against this same long-lived
		// fixture — strip any lingering `.warren/` from the source repo and
		// commit the removal so we start each acceptance pass from the
		// "absent" state. (Idempotent: no-op if the dir was never created.)
		await resetSourceWarrenDir(ctx.fixtures.sampleProjectPath);
		await refreshProject(http, project.id);
		assertTrue(
			!existsSync(warrenDirInClone),
			`scenario-14 setup: clone still has .warren/ after reset+refresh: ${warrenDirInClone}`,
		);

		/* -------------------------------------------------------------- */
		/* State 1 — absent                                               */
		/* -------------------------------------------------------------- */
		const absentEnvelope = await getWarrenConfig(http, project.id);
		assertEqual(absentEnvelope.triggers, null, "absent: triggers is null");
		assertEqual(absentEnvelope.defaults, null, "absent: defaults is null");
		assertEqual(absentEnvelope.errors.length, 0, "absent: no per-file errors");

		const absentReadyzCheck = await readyzWarrenConfigCheck(http);
		assertEqual(
			absentReadyzCheck.ok,
			true,
			`absent: warren_config check should be ok; got message=${JSON.stringify(absentReadyzCheck.message)}`,
		);
		assertTrue(
			(absentReadyzCheck.message ?? "").includes("no .warren/ failures") ||
				(absentReadyzCheck.message ?? "").includes("project(s) checked"),
			`absent: warren_config message should report a clean walk; got ${JSON.stringify(absentReadyzCheck.message)}`,
		);

		/* -------------------------------------------------------------- */
		/* State 2 — valid                                                */
		/* -------------------------------------------------------------- */
		await mkdir(warrenDirInSource, { recursive: true });
		const validTriggers = [
			`- id: ${TRIGGER_ID}`,
			"  kind: cron",
			`  cron: '${TRIGGER_CRON}'`,
			`  seed: ${TRIGGER_SEED}`,
			`  role: ${TRIGGER_ROLE}`,
			"",
		].join("\n");
		const validDefaults = JSON.stringify(
			{ defaultBranch: DEFAULT_BRANCH, defaultRole: DEFAULT_ROLE },
			null,
			2,
		);
		await writeFile(join(warrenDirInSource, "triggers.yaml"), validTriggers);
		await writeFile(join(warrenDirInSource, "defaults.json"), validDefaults);
		await commitInSource(ctx.fixtures.sampleProjectPath, "scenario-14: add valid .warren/");
		await refreshProject(http, project.id);
		assertTrue(
			existsSync(join(warrenDirInClone, "triggers.yaml")),
			`valid: refresh did not pull triggers.yaml into ${warrenDirInClone}`,
		);

		const validEnvelope = await getWarrenConfig(http, project.id);
		assertEqual(validEnvelope.errors.length, 0, "valid: no per-file errors");
		assertTrue(
			validEnvelope.triggers !== null && validEnvelope.triggers.length === 1,
			`valid: expected one parsed trigger; got ${JSON.stringify(validEnvelope.triggers)}`,
		);
		const trigger = validEnvelope.triggers?.[0];
		assertEqual(trigger?.id, TRIGGER_ID, "valid: trigger id round-trips");
		assertEqual(trigger?.kind, "cron", "valid: trigger kind round-trips");
		assertEqual(trigger?.cron, TRIGGER_CRON, "valid: trigger cron round-trips");
		assertEqual(trigger?.seed, TRIGGER_SEED, "valid: trigger seed round-trips");
		assertEqual(trigger?.role, TRIGGER_ROLE, "valid: trigger role round-trips");
		assertTrue(validEnvelope.defaults !== null, "valid: defaults parsed (not null)");
		assertEqual(
			validEnvelope.defaults?.defaultBranch,
			DEFAULT_BRANCH,
			"valid: defaults.defaultBranch round-trips",
		);
		assertEqual(
			validEnvelope.defaults?.defaultRole,
			DEFAULT_ROLE,
			"valid: defaults.defaultRole round-trips",
		);

		const validReadyzCheck = await readyzWarrenConfigCheck(http);
		assertEqual(
			validReadyzCheck.ok,
			true,
			`valid: warren_config check should be ok; got message=${JSON.stringify(validReadyzCheck.message)}`,
		);

		/* -------------------------------------------------------------- */
		/* State 3 — malformed                                            */
		/* -------------------------------------------------------------- */
		// Schema violation: missing required `seed` and `role`. Yaml itself
		// is well-formed, so the loader's parse step succeeds and the schema
		// step records the failure (warren_config_schema_error).
		const malformedTriggers = [
			`- id: ${TRIGGER_ID}`,
			"  kind: cron",
			`  cron: '${TRIGGER_CRON}'`,
			"",
		].join("\n");
		// JSON parse error: trailing brace + bare keyword.
		const malformedDefaults = "{not valid json";
		await writeFile(join(warrenDirInSource, "triggers.yaml"), malformedTriggers);
		await writeFile(join(warrenDirInSource, "defaults.json"), malformedDefaults);
		await commitInSource(ctx.fixtures.sampleProjectPath, "scenario-14: corrupt .warren/");
		await refreshProject(http, project.id);

		const malformedEnvelope = await getWarrenConfig(http, project.id);
		assertEqual(malformedEnvelope.triggers, null, "malformed: triggers is null on schema failure");
		assertEqual(malformedEnvelope.defaults, null, "malformed: defaults is null on parse failure");
		assertEqual(
			malformedEnvelope.errors.length,
			2,
			`malformed: expected 2 per-file errors; got ${JSON.stringify(malformedEnvelope.errors)}`,
		);
		const triggersErr = malformedEnvelope.errors.find((e) => e.file === ".warren/triggers.yaml");
		const defaultsErr = malformedEnvelope.errors.find((e) => e.file === ".warren/defaults.json");
		if (triggersErr === undefined || defaultsErr === undefined) {
			throw new AcceptanceError(
				`malformed: expected entries for both .warren/ files; got ${JSON.stringify(malformedEnvelope.errors)}`,
			);
		}
		assertEqual(
			triggersErr.code,
			"warren_config_schema_error",
			"malformed: triggers.yaml carries the schema-error code",
		);
		assertEqual(
			defaultsErr.code,
			"warren_config_parse_error",
			"malformed: defaults.json carries the parse-error code",
		);

		const malformedReadyzCheck = await readyzWarrenConfigCheck(http);
		assertEqual(
			malformedReadyzCheck.ok,
			false,
			`malformed: warren_config check should fail; got message=${JSON.stringify(malformedReadyzCheck.message)}`,
		);
		const message = malformedReadyzCheck.message ?? "";
		assertTrue(
			message.includes(".warren/"),
			`malformed: warren_config message should reference .warren/; got ${JSON.stringify(message)}`,
		);
		assertTrue(
			message.includes(project.id),
			`malformed: warren_config message should name the offending project; got ${JSON.stringify(message)}`,
		);
		const hint = malformedReadyzCheck.hint ?? "";
		assertTrue(
			hint.length > 0,
			`malformed: warren_config check should carry a hint; got ${JSON.stringify(malformedReadyzCheck)}`,
		);

		/* -------------------------------------------------------------- */
		/* Cleanup — restore the fixture for sibling scenarios.           */
		/* The harness shares one source repo across the suite; leaving   */
		/* the corrupt files in place would noise up later runs even      */
		/* though the scenario above proves correctness.                  */
		/* -------------------------------------------------------------- */
		await resetSourceWarrenDir(ctx.fixtures.sampleProjectPath);
		await refreshProject(http, project.id);
	},
};

async function ensureSampleProject(http: WarrenHttp, gitUrl: string): Promise<ProjectRow> {
	const list = await http.expectJson<{ projects: ProjectRow[] }>("GET", "/projects", 200);
	const existing = list.projects.find((p) => p.gitUrl === gitUrl);
	if (existing !== undefined) return existing;
	return http.expectJson<ProjectRow>("POST", "/projects", 201, { body: { gitUrl } });
}

async function getWarrenConfig(http: WarrenHttp, projectId: string): Promise<WarrenConfigResponse> {
	return http.expectJson<WarrenConfigResponse>(
		"GET",
		`/projects/${encodeURIComponent(projectId)}/warren-config`,
		200,
	);
}

async function refreshProject(http: WarrenHttp, projectId: string): Promise<RefreshResponse> {
	return http.expectJson<RefreshResponse>(
		"POST",
		`/projects/${encodeURIComponent(projectId)}/refresh`,
		200,
	);
}

async function readyzWarrenConfigCheck(http: WarrenHttp): Promise<ReadyzCheck> {
	const res = await http.request("GET", "/readyz");
	if (res.status !== 200 && res.status !== 503) {
		throw new AcceptanceError(`/readyz returned unexpected status ${res.status}`);
	}
	const body = (await res.json()) as ReadyzResponse;
	const check = body.checks.find((c) => c.name === "warren_config");
	if (check === undefined) {
		throw new AcceptanceError(
			`/readyz missing warren_config check; got names [${body.checks.map((c) => c.name).join(", ")}]`,
		);
	}
	return check;
}

async function resetSourceWarrenDir(sourceRepoPath: string): Promise<void> {
	const warrenDir = join(sourceRepoPath, ".warren");
	if (!existsSync(warrenDir)) return;
	await rm(warrenDir, { recursive: true, force: true });
	// The removal needs to be a commit so refreshProject's hard reset
	// drops the dir from the clone. `git add -A` stages the deletion.
	await runGit(sourceRepoPath, ["add", "-A"]);
	const status = await runGit(sourceRepoPath, ["status", "--porcelain"]);
	if (status.stdout.trim() === "") return;
	await runGit(sourceRepoPath, ["commit", "-m", "scenario-14: reset .warren/"]);
}

async function commitInSource(sourceRepoPath: string, message: string): Promise<void> {
	await runGit(sourceRepoPath, ["add", "-A"]);
	await runGit(sourceRepoPath, ["commit", "-m", message]);
}

async function runGit(
	cwd: string,
	args: readonly string[],
): Promise<{ stdout: string; stderr: string }> {
	const proc = Bun.spawn({
		cmd: ["git", ...args],
		cwd,
		env: {
			PATH: process.env.PATH ?? "",
			HOME: process.env.HOME ?? "/tmp",
			GIT_AUTHOR_NAME: "Warren Acceptance",
			GIT_AUTHOR_EMAIL: "acceptance@warren.invalid",
			GIT_COMMITTER_NAME: "Warren Acceptance",
			GIT_COMMITTER_EMAIL: "acceptance@warren.invalid",
		},
		stdin: "ignore",
		stdout: "pipe",
		stderr: "pipe",
	});
	const [stdout, stderr, exitCode] = await Promise.all([
		new Response(proc.stdout).text(),
		new Response(proc.stderr).text(),
		proc.exited,
	]);
	if ((exitCode ?? 0) !== 0) {
		throw new AcceptanceError(
			`git ${args.join(" ")} in ${cwd} exited ${exitCode}\nstderr: ${stderr}`,
		);
	}
	return { stdout, stderr };
}
