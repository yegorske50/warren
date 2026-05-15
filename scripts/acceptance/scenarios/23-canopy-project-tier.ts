/**
 * Scenario 23 — canopy project-tier roundtrip (R-03, pl-fef5 step 9).
 *
 * Acceptance criterion #7 of pl-fef5 (the plan that introduced the
 * per-project `.canopy/` tier) calls for an end-to-end scenario named
 * `22-canopy-project-tier.ts`. That slot was already claimed by
 * `22-seeds-extensions-roundtrip` between plan submission and this
 * step, so the scenario lands at id 23. The contract is unchanged —
 * this is the project-tier roundtrip the plan asked for.
 *
 * Covers acceptance criteria #3, #5, #6 of pl-fef5 end-to-end against a
 * live warren+burrow stack:
 *   3. `POST /projects/:id/agents/refresh` stamps `source = project:<id>`
 *      on each registered row and the global tier is untouched.
 *   5. `GET /agents` returns global only when no filter is set;
 *      `GET /agents?projectId=<id>` returns global ∪ that project's tier;
 *      `GET /agents/:name?projectId=<id>` resolves project-first.
 *   6. `POST /runs` with a name that exists in BOTH tiers picks the
 *      project-tier row and the frozen `runs.rendered_agent_json
 *      .frontmatter.source` reflects the chosen tier.
 *
 * Layout mirrors scenario 14: bootstrap `.canopy/` in the source repo,
 * commit, refresh so the project clone has the new prompt; assert the
 * registry + listing + resolve + spawn contracts; reset source state at
 * the end so subsequent scenarios see a clean fixture.
 *
 * The fixture's `stub-shell` agent is already declared in `burrow.toml`
 * and registered as a library-tier prompt by scenario 02. Re-using the
 * same name at the project tier is what makes the override observable
 * — listing returns both rows and spawn picks the project-tier one
 * (source `project:<id>` in the frozen agent JSON), while the global
 * row survives the scenario for downstream scenarios that depend on
 * the library tier.
 *
 * Mode: in-proc only. Container mode does not bind-mount the host
 * sample project (mx-96d833), so we have no way to drive the source-
 * repo edits from outside the container. Same posture as 14 and 22.
 */

import { existsSync } from "node:fs";
import { rm } from "node:fs/promises";
import { join } from "node:path";

import { AcceptanceError, assertEqual, assertTrue, type Scenario } from "../lib/assert.ts";
import { WarrenHttp } from "../lib/http.ts";

interface ProjectRow {
	readonly id: string;
	readonly gitUrl: string;
	readonly localPath: string;
	readonly defaultBranch: string;
}

interface AgentRow {
	readonly name: string;
	readonly projectId: string | null;
	readonly source: string;
	readonly renderedJson: {
		readonly frontmatter?: { readonly source?: string };
		readonly sections?: Record<string, string>;
	};
}

interface RefreshResponse {
	readonly project: ProjectRow;
}

interface ProjectRefreshResponse {
	readonly projectId: string;
	readonly registered: AgentRow[];
	readonly skipped: ReadonlyArray<{ readonly name: string; readonly reason: string }>;
	readonly removed: readonly string[];
}

interface RunRow {
	readonly id: string;
	readonly state: string;
	readonly agentName: string;
	readonly projectId: string | null;
	readonly renderedAgentJson: {
		readonly frontmatter?: { readonly source?: string };
		readonly sections?: Record<string, string>;
	};
}

interface CreateRunResponse {
	readonly run: RunRow;
	readonly burrow: { readonly id: string; readonly workspacePath: string };
}

const TERMINAL_STATES = new Set(["succeeded", "failed", "cancelled"]);
const PROJECT_TIER_MARKER = "project-tier system prompt (scenario-23)";

export const scenario: Scenario = {
	id: "23",
	title:
		"Per-project .canopy/ tier — refresh stamps source=project:<id>, listing dedupes by scope, spawn prefers project tier",
	modes: ["in-proc"],
	async run(ctx) {
		const http = new WarrenHttp({ baseUrl: ctx.warrenUrl, token: ctx.token });

		// Library tier must be primed so the "name present in both tiers"
		// assertion is meaningful. Scenario 02 already does this, but the
		// suite may be run with `--only 23`, so retrigger here. Cheap.
		await http.expectStatus("POST", "/agents/refresh", 200);
		const project = await ensureSampleProject(http, ctx.fixtures.sampleProjectGitUrl);

		// Idempotency posture: prior scenario runs may have left a
		// `.canopy/` behind in the source repo. Strip it so we start the
		// run from the "no project tier" state.
		await resetSourceCanopyDir(ctx.fixtures.sampleProjectPath);
		await refreshProject(http, project.id);

		// Confirm the library tier alone returns the stub-shell row with
		// `source=library`. This is the baseline the project-tier override
		// is going to displace.
		const baseline = await http.expectJson<{ agents: AgentRow[] }>("GET", "/agents", 200);
		const baselineStub = baseline.agents.find((a) => a.name === ctx.fixtures.stubAgentName);
		assertTrue(
			baselineStub !== undefined,
			`baseline: GET /agents must include the library-tier ${ctx.fixtures.stubAgentName}`,
		);
		assertEqual(
			baselineStub?.source,
			"library",
			"baseline: library-tier stub-shell has source=library",
		);

		// ----------------------------------------------------------------
		// Write a project-tier `.canopy/` into the source repo carrying a
		// prompt with the same `stub-shell` name. `cn init` creates the
		// store; `cn create` writes the prompt; `cn sync` commits. We then
		// `refreshProject` so the project clone fetches it from origin.
		// ----------------------------------------------------------------
		await initSourceCanopy(ctx.fixtures.sampleProjectPath);
		await createProjectAgent(
			ctx.fixtures.sampleProjectPath,
			ctx.fixtures.stubAgentName,
			PROJECT_TIER_MARKER,
		);
		await commitSourceCanopy(
			ctx.fixtures.sampleProjectPath,
			`scenario-23: add project-tier .canopy/ ${ctx.fixtures.stubAgentName}`,
		);
		await refreshProject(http, project.id);
		assertTrue(
			existsSync(join(project.localPath, ".canopy")),
			`refresh did not pull .canopy/ into ${project.localPath}`,
		);

		// ----------------------------------------------------------------
		// POST /projects/:id/agents/refresh — registers the prompt at the
		// project tier with source=project:<projectId>. Global tier rows
		// (claude-code/sapling/pi builtins + library stub-shell) must
		// survive unchanged.
		// ----------------------------------------------------------------
		const refresh = await http.expectJson<ProjectRefreshResponse>(
			"POST",
			`/projects/${encodeURIComponent(project.id)}/agents/refresh`,
			200,
		);
		assertEqual(
			refresh.projectId,
			project.id,
			"POST .../agents/refresh: response.projectId echoes the path id",
		);
		assertEqual(
			refresh.skipped.length,
			0,
			`POST .../agents/refresh: no prompts should be skipped; got ${JSON.stringify(refresh.skipped)}`,
		);
		const registered = refresh.registered.find((a) => a.name === ctx.fixtures.stubAgentName);
		if (registered === undefined) {
			throw new AcceptanceError(
				`POST .../agents/refresh: ${ctx.fixtures.stubAgentName} missing from registered; got ${JSON.stringify(refresh.registered.map((a) => a.name))}`,
			);
		}
		assertEqual(
			registered.projectId,
			project.id,
			"POST .../agents/refresh: registered row has projectId set",
		);
		assertEqual(
			registered.source,
			`project:${project.id}`,
			"POST .../agents/refresh: registered row carries source=project:<projectId>",
		);
		assertTrue(
			registered.renderedJson?.frontmatter?.source === `project:${project.id}`,
			"POST .../agents/refresh: renderedJson.frontmatter.source mirrors the project tier",
		);

		// ----------------------------------------------------------------
		// GET /agents (no filter) — must return the LIBRARY tier only.
		// Global rows survived; project-tier row is invisible without an
		// explicit ?projectId filter.
		// ----------------------------------------------------------------
		const noFilter = await http.expectJson<{ agents: AgentRow[] }>("GET", "/agents", 200);
		const noFilterMatches = noFilter.agents.filter((a) => a.name === ctx.fixtures.stubAgentName);
		assertEqual(
			noFilterMatches.length,
			1,
			`GET /agents (no filter): expected one stub-shell row; got ${noFilterMatches.length}`,
		);
		assertEqual(
			noFilterMatches[0]?.source,
			"library",
			"GET /agents (no filter): the surviving row is the library tier",
		);
		assertTrue(
			noFilterMatches[0]?.projectId === null || noFilterMatches[0]?.projectId === undefined,
			"GET /agents (no filter): library-tier row has null/undefined projectId",
		);

		// ----------------------------------------------------------------
		// GET /agents?projectId=<id> — returns BOTH library and project
		// tiers (listAll's union with project_id IS NULL OR =:projectId).
		// Dedup belongs at the UI layer, not the HTTP layer.
		// ----------------------------------------------------------------
		const scoped = await http.expectJson<{ agents: AgentRow[] }>(
			"GET",
			`/agents?projectId=${encodeURIComponent(project.id)}`,
			200,
		);
		const scopedMatches = scoped.agents.filter((a) => a.name === ctx.fixtures.stubAgentName);
		assertEqual(
			scopedMatches.length,
			2,
			`GET /agents?projectId=<id>: expected both tiers for ${ctx.fixtures.stubAgentName}; got ${scopedMatches.length}`,
		);
		const scopedLibrary = scopedMatches.find((a) => a.source === "library");
		const scopedProject = scopedMatches.find((a) => a.source === `project:${project.id}`);
		assertTrue(
			scopedLibrary !== undefined,
			"GET /agents?projectId=<id>: library-tier row missing from the union",
		);
		assertTrue(
			scopedProject !== undefined,
			"GET /agents?projectId=<id>: project-tier row missing from the union",
		);
		assertEqual(
			scopedProject?.projectId,
			project.id,
			"GET /agents?projectId=<id>: project-tier row has projectId set to the scope",
		);

		// ----------------------------------------------------------------
		// GET /agents/:name?projectId=<id> — `resolve` prefers the project
		// tier when both exist (warren-0a7e). Same contract spawn uses.
		// ----------------------------------------------------------------
		const detailScoped = await http.expectJson<AgentRow>(
			"GET",
			`/agents/${encodeURIComponent(ctx.fixtures.stubAgentName)}?projectId=${encodeURIComponent(project.id)}`,
			200,
		);
		assertEqual(
			detailScoped.source,
			`project:${project.id}`,
			"GET /agents/:name?projectId=<id>: detail resolves to the project tier when both exist",
		);
		assertEqual(
			detailScoped.projectId,
			project.id,
			"GET /agents/:name?projectId=<id>: detail row carries the project id",
		);
		const detailScopedSystem = detailScoped.renderedJson?.sections?.system ?? "";
		assertTrue(
			detailScopedSystem.includes(PROJECT_TIER_MARKER),
			`GET /agents/:name?projectId=<id>: detail.renderedJson.sections.system must include the project marker; got ${JSON.stringify(detailScopedSystem)}`,
		);

		// Same name without the filter falls back to the global row.
		const detailGlobal = await http.expectJson<AgentRow>(
			"GET",
			`/agents/${encodeURIComponent(ctx.fixtures.stubAgentName)}`,
			200,
		);
		assertEqual(
			detailGlobal.source,
			"library",
			"GET /agents/:name (no filter): no fallback to project tier — returns the global row",
		);

		// ----------------------------------------------------------------
		// POST /runs — spawn calls `agents.resolve(name, {projectId})`,
		// freezes the chosen agent definition into runs.rendered_agent_json.
		// The frozen frontmatter.source MUST reflect the project tier
		// (acceptance #6 of pl-fef5).
		// ----------------------------------------------------------------
		const created = await http.expectJson<CreateRunResponse>("POST", "/runs", 201, {
			body: {
				agent: ctx.fixtures.stubAgentName,
				project: project.id,
				prompt: "[sleep_ms=8000] scenario-23 project-tier dispatch",
			},
		});
		const frozen = created.run.renderedAgentJson ?? {};
		assertEqual(
			frozen.frontmatter?.source,
			`project:${project.id}`,
			"POST /runs: runs.rendered_agent_json.frontmatter.source records the chosen tier",
		);
		assertTrue(
			(frozen.sections?.system ?? "").includes(PROJECT_TIER_MARKER),
			`POST /runs: runs.rendered_agent_json.sections.system must include the project-tier marker; got ${JSON.stringify(frozen.sections?.system ?? "")}`,
		);

		const reread = await http.expectJson<RunRow>(
			"GET",
			`/runs/${encodeURIComponent(created.run.id)}`,
			200,
		);
		assertEqual(
			reread.renderedAgentJson?.frontmatter?.source,
			`project:${project.id}`,
			"GET /runs/:id: persisted renderedAgentJson echoes the project-tier source",
		);

		// Cancel + drain so teardown doesn't race the 8s stub sleep.
		await cancelAndDrain(http, created.run.id);

		// ----------------------------------------------------------------
		// Cleanup — drop the project's `.canopy/` so subsequent scenarios
		// (and re-runs of this one) start from the "no project tier" state.
		// Mirrors scenario 14's reset posture.
		// ----------------------------------------------------------------
		await resetSourceCanopyDir(ctx.fixtures.sampleProjectPath);
		await refreshProject(http, project.id);
	},
};

async function ensureSampleProject(http: WarrenHttp, gitUrl: string): Promise<ProjectRow> {
	const list = await http.expectJson<{ projects: ProjectRow[] }>("GET", "/projects", 200);
	const existing = list.projects.find((p) => p.gitUrl === gitUrl);
	if (existing !== undefined) return existing;
	return http.expectJson<ProjectRow>("POST", "/projects", 201, { body: { gitUrl } });
}

async function refreshProject(http: WarrenHttp, projectId: string): Promise<RefreshResponse> {
	return http.expectJson<RefreshResponse>(
		"POST",
		`/projects/${encodeURIComponent(projectId)}/refresh`,
		200,
	);
}

async function initSourceCanopy(sourceRepoPath: string): Promise<void> {
	// `cn init` is not idempotent at the FS level (writes a fresh
	// config.yaml + prompts.jsonl + schemas.jsonl). The resetSourceCanopyDir
	// caller strips `.canopy/` before this runs, so we can assume a clean
	// slate.
	await runCn(sourceRepoPath, ["init"]);
}

async function createProjectAgent(
	sourceRepoPath: string,
	agentName: string,
	systemBody: string,
): Promise<void> {
	await runCn(sourceRepoPath, [
		"create",
		"--name",
		agentName,
		"--tag",
		"agent",
		"--description",
		`scenario-23 project-tier ${agentName}`,
		"--section",
		`system=${systemBody}`,
	]);
}

async function commitSourceCanopy(sourceRepoPath: string, message: string): Promise<void> {
	// Prefer `cn sync` (matches the canopy fixture's pattern) and fall back
	// to a plain add+commit if it's unavailable on the harness's cn binary.
	try {
		await runCn(sourceRepoPath, ["sync"]);
	} catch {
		await runGit(sourceRepoPath, ["add", "."]);
		await runGit(sourceRepoPath, ["commit", "-m", message]);
		return;
	}
	// `cn sync` may no-op if there is nothing to commit (already in sync);
	// the explicit add+commit below picks up any residual changes (the
	// .gitattributes warren-acceptance writes on first init, etc.) so the
	// commit always lands.
	await runGit(sourceRepoPath, ["add", "."]);
	const status = await runGit(sourceRepoPath, ["status", "--porcelain"]);
	if (status.stdout.trim() === "") return;
	await runGit(sourceRepoPath, ["commit", "-m", message]);
}

async function resetSourceCanopyDir(sourceRepoPath: string): Promise<void> {
	const canopyDir = join(sourceRepoPath, ".canopy");
	if (existsSync(canopyDir)) {
		await rm(canopyDir, { recursive: true, force: true });
	}
	// `cn init` also writes a `.gitattributes` with the prompts.jsonl
	// merge=union directive. Drop it on reset so the fixture's git state
	// returns to baseline.
	const gitAttrs = join(sourceRepoPath, ".gitattributes");
	if (existsSync(gitAttrs)) {
		await rm(gitAttrs, { force: true });
	}
	await runGit(sourceRepoPath, ["add", "-A"]);
	const status = await runGit(sourceRepoPath, ["status", "--porcelain"]);
	if (status.stdout.trim() === "") return;
	await runGit(sourceRepoPath, ["commit", "-m", "scenario-23: reset .canopy/"]);
}

async function cancelAndDrain(http: WarrenHttp, runId: string): Promise<void> {
	try {
		await http.request("POST", `/runs/${encodeURIComponent(runId)}/cancel`, { body: {} });
	} catch {
		// Best-effort — the run may already be terminal.
	}
	const deadline = Date.now() + 10_000;
	while (Date.now() < deadline) {
		const row = await http.expectJson<RunRow>("GET", `/runs/${encodeURIComponent(runId)}`, 200);
		if (TERMINAL_STATES.has(row.state)) return;
		await sleep(100);
	}
	// Don't fail the scenario on a stuck terminal transition — teardown
	// kills the warren+burrow pair regardless.
}

async function runCn(
	cwd: string,
	args: readonly string[],
): Promise<{ stdout: string; stderr: string }> {
	const proc = Bun.spawn({
		cmd: ["cn", ...args],
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
			`cn ${args.join(" ")} in ${cwd} exited ${exitCode}\nstderr: ${stderr}`,
		);
	}
	return { stdout, stderr };
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

function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}
