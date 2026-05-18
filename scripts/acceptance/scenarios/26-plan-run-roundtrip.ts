/**
 * Scenario 26 — plan-run roundtrip (pl-a258 step 9 / warren-ae00).
 *
 * Closes the loop the per-step unit tests open: warren-9990 wires
 * hasSeeds, warren-4d7c lands the DB tables, warren-a3ea adds the
 * seeds-cli plan readers, warren-9e4c the PR-merge polling helper,
 * warren-2623 the coordinator state machine, warren-f923 the server API
 * surface, warren-a87f the UI. This scenario chains them through a real
 * warren+burrow stack against a `.seeds/`-enabled fixture.
 *
 * Topology mirrors scenario 22 (closest twin): an in-proc warren+burrow
 * pair against a bespoke fixture committed under `ctx.tmp`. The shared
 * sample-source isn't reused — scenario 22's seed-extension roundtrip
 * already mutates that path, and the harness boots one warren for every
 * scenario; isolating into a per-scenario stack keeps the GH-merge
 * fetch override (`WARREN_GH_FETCH_OVERRIDE=merged`) scoped to this
 * scenario alone.
 *
 * The fixture commits real `.seeds/{config.yaml, issues.jsonl, plans.jsonl}`
 * rows (mirrors scenario 22's posture of writing files rather than shelling
 * `sd plan submit`, so the harness stays deterministic). Three children:
 *
 *   - ah-acc-26-a — open; agent dispatches, closes via the stub, reap
 *     opens a stubbed PR, coordinator polls merged, child advances.
 *   - ah-acc-26-b — open; same.
 *   - ah-acc-26-c — open AND listed in `WARREN_STUB_NO_COMMIT_SEEDS`,
 *     so the stub agent skips every workspace mutation. Reap reports
 *     `commitsAhead=0` + emits `reap.empty_push`, and the coordinator
 *     drives the trivial-merge branch (no GH polling, child → merged).
 *
 * Then a SECOND POST after rewriting the source seed row for
 * ah-acc-26-b to `status=closed` verifies the resume contract
 * (warren-fcc9): the closed child flips directly to `skipped` without
 * dispatching a run.
 *
 * In-proc only: drives source-repo edits the container harness doesn't
 * bind-mount (matches scenario 22 / mx-1d31f0 posture).
 */

import { existsSync } from "node:fs";
import { copyFile, mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { AcceptanceError, assertEqual, assertTrue, type Scenario } from "../lib/assert.ts";
import { WarrenHttp } from "../lib/http.ts";
import { type BootHandle, bootInProc } from "../lib/inproc.ts";

interface ProjectRow {
	readonly id: string;
	readonly gitUrl: string;
	readonly localPath: string;
	readonly defaultBranch: string;
	readonly hasSeeds?: boolean;
}

interface RunRow {
	readonly id: string;
	readonly state: string;
	readonly trigger: string;
	readonly prUrl: string | null;
}

interface PlanRunRow {
	readonly id: string;
	readonly planId: string;
	readonly projectId: string;
	readonly agentName: string;
	readonly state: "queued" | "running" | "succeeded" | "failed" | "cancelled";
}

interface PlanRunChildRow {
	readonly planRunId: string;
	readonly seq: number;
	readonly seedId: string;
	readonly runId: string | null;
	readonly state:
		| "pending"
		| "dispatched"
		| "running"
		| "pr_open"
		| "merged"
		| "failed"
		| "skipped";
}

interface CreatePlanRunResponse {
	readonly planRun: PlanRunRow;
	readonly children: readonly PlanRunChildRow[];
}

interface PlanRunDetailResponse {
	readonly planRun: PlanRunRow;
	readonly children: readonly PlanRunChildRow[];
	readonly runs: readonly RunRow[];
}

interface EventRow {
	readonly id: number;
	readonly runId: string;
	readonly seq: number;
	readonly kind: string;
	readonly stream: string | null;
	readonly payload: Record<string, unknown> | null;
}

const PLAN_PROJECT_URL = "https://github.com/warren-acceptance/sample-plan-run.git";
const PLAN_ID = "pl-acc-26";
const SEED_A = "ah-acc-26-a";
const SEED_B = "ah-acc-26-b";
const SEED_C = "ah-acc-26-c";
const SEED_TS = "2026-05-15T00:00:00.000Z";

const TERMINAL_PLAN_STATES = new Set(["succeeded", "failed", "cancelled"]);
const PLAN_DEADLINE_MS = 90_000;
const POLL_INTERVAL_MS = 500;

export const scenario: Scenario = {
	id: "26",
	title:
		"Plan-run roundtrip — coordinator dispatches three children, merges via stubbed GH PR, trivial-merges the no-commit child; second POST resumes from the next open seed",
	modes: ["in-proc"],
	async run(ctx) {
		const scenarioRoot = await mkdtemp(join(tmpdir(), "warren-acceptance-26-"));
		const fixturePath = join(scenarioRoot, "fixture");
		const gitConfigPath = join(scenarioRoot, "git-config");

		await buildPlanRunFixture({
			fixturePath,
			sourceSamplePath: ctx.fixtures.sampleProjectPath,
			harnessGitConfigPath: join(ctx.tmp, "git-config"),
			gitConfigPath,
			projectGitUrl: PLAN_PROJECT_URL,
		});

		let handle: BootHandle | undefined;
		try {
			handle = await bootInProc({
				tmpRoot: join(scenarioRoot, "warren"),
				token: ctx.token,
				canopyRepoUrl: ctx.fixtures.canopyRepoUrl,
				gitConfigPath,
				extraEnv: {
					WARREN_STUB_SLEEP_MS: "0",
					// Stub every GitHub REST call so reap's pr_open + the
					// coordinator's checkPullRequestMerged short-circuit to a
					// canned `merged` shape — no real GH fixture needed.
					WARREN_GH_FETCH_OVERRIDE: "merged",
					// Drive the trivial-merge branch on the third child by
					// telling the stub agent to skip every workspace mutation
					// for that seed id.
					WARREN_STUB_NO_COMMIT_SEEDS: SEED_C,
					// Coordinator tick fires every 1s so the three-child
					// roundtrip lands inside PLAN_DEADLINE_MS.
					WARREN_PLAN_RUN_TICK_MS: "1000",
				},
			});
			ctx.logger.info(`scenario-26: warren ready at ${handle.warrenUrl}`);

			const http = new WarrenHttp({ baseUrl: handle.warrenUrl, token: handle.token });
			await http.expectStatus("POST", "/agents/refresh", 200);

			const project = await http.expectJson<ProjectRow>("POST", "/projects", 201, {
				body: { gitUrl: PLAN_PROJECT_URL },
			});
			assertEqual(
				project.hasSeeds,
				true,
				"plan-run fixture project surfaces hasSeeds=true after clone (warren-9990)",
			);

			// === First POST: full happy-path roundtrip ===
			const created = await http.expectJson<CreatePlanRunResponse>("POST", "/plan-runs", 201, {
				body: {
					project: project.id,
					planId: PLAN_ID,
					agent: "claude-code",
					promptTemplate: "closeseed {seed_id}",
				},
			});
			assertEqual(created.planRun.state, "queued", "first POST: plan-run state starts as 'queued'");
			assertEqual(created.children.length, 3, "first POST: 3 child rows created");
			for (const child of created.children) {
				assertEqual(
					child.state,
					"pending",
					`first POST: child seq=${child.seq} state starts as 'pending'`,
				);
			}
			const planRunId = created.planRun.id;
			ctx.logger.debug(`scenario-26: planRunId=${planRunId}`);

			const finished = await waitForPlanState(http, planRunId, "succeeded", PLAN_DEADLINE_MS);
			assertEqual(
				finished.planRun.state,
				"succeeded",
				"first POST: plan-run reaches terminal 'succeeded'",
			);
			assertEqual(finished.children.length, 3, "first POST: still 3 children");
			for (const child of finished.children) {
				assertEqual(
					child.state,
					"merged",
					`first POST: child seq=${child.seq} (seed=${child.seedId}) ended in 'merged' (no failures/skips)`,
				);
				assertTrue(
					typeof child.runId === "string" && child.runId.length > 0,
					`first POST: child seq=${child.seq} has a runId`,
				);
			}

			// Every child run carries trigger='plan-run' and the planRun→run
			// link is recoverable via plan_run_children.run_id (no metadata
			// column exists on warren's runs table today; the dispatch
			// metadata is forwarded into burrow only).
			assertEqual(finished.runs.length, 3, "first POST: detail response fans out 3 runs");
			for (const run of finished.runs) {
				assertEqual(
					run.trigger,
					"plan-run",
					`first POST: run ${run.id} trigger='plan-run' (createPlanRunSpawn wires it)`,
				);
				const linkedChild = finished.children.find((c) => c.runId === run.id);
				if (linkedChild === undefined) {
					throw new AcceptanceError(
						`first POST: run ${run.id} has trigger='plan-run' but no plan_run_children row links to it`,
					);
				}
			}

			// One child must have hit the trivial-merge branch (prUrl=null +
			// reap.empty_push), the other two land via the polled merge path.
			const trivialChild = finished.children.find((c) => c.seedId === SEED_C);
			if (trivialChild === undefined) {
				throw new AcceptanceError(`first POST: missing child for ${SEED_C}`);
			}
			const trivialRun = finished.runs.find((r) => r.id === trivialChild.runId);
			if (trivialRun === undefined) {
				throw new AcceptanceError(
					`first POST: could not locate the fanned-out run for trivial-merge child (runId=${trivialChild.runId})`,
				);
			}
			assertEqual(
				trivialRun.prUrl,
				null,
				`first POST: ${SEED_C} run's prUrl stays null (no-commit child → trivial-merge)`,
			);
			for (const seedId of [SEED_A, SEED_B]) {
				const child = finished.children.find((c) => c.seedId === seedId);
				if (child === undefined) {
					throw new AcceptanceError(`first POST: missing child for ${seedId}`);
				}
				const run = finished.runs.find((r) => r.id === child.runId);
				if (run === undefined) {
					throw new AcceptanceError(`first POST: no fanned-out run for ${seedId}`);
				}
				assertTrue(
					typeof run.prUrl === "string" && run.prUrl.length > 0,
					`first POST: ${seedId} run.prUrl populated by the GH-override pr_open stub`,
				);
			}

			// Event stream surfaces the coordinator's lifecycle kinds.
			const planRunEvents = await fetchAllPlanRunEvents(http, planRunId);
			const seenKinds = new Set(planRunEvents.map((e) => e.kind));
			for (const kind of [
				"plan_run.dispatched",
				"plan_run.merged",
				"plan_run.succeeded",
			] as const) {
				if (!seenKinds.has(kind)) {
					throw new AcceptanceError(
						`first POST: plan-run event stream missing '${kind}'; saw kinds=[${[...seenKinds].join(", ")}]`,
					);
				}
			}

			// === Second POST: resume semantics on closed children ===
			//
			// Mutate the source repo so ah-acc-26-b is `closed`, then refresh
			// the project clone. The coordinator's per-child showSeed should
			// catch the closed status and flip child seq=2 to 'skipped'
			// without spawning a run (warren-fcc9 resume contract).
			await rewriteSourceSeedClosed(fixturePath, SEED_B);
			await http.expectJson<unknown>(
				"POST",
				`/projects/${encodeURIComponent(project.id)}/refresh`,
				200,
			);

			const resumed = await http.expectJson<CreatePlanRunResponse>("POST", "/plan-runs", 201, {
				body: {
					project: project.id,
					planId: PLAN_ID,
					agent: "claude-code",
					promptTemplate: "closeseed {seed_id}",
				},
			});
			assertEqual(
				resumed.children.length,
				3,
				"second POST: same plan id → same 3 child seeds enumerated",
			);
			const finishedResumed = await waitForPlanState(
				http,
				resumed.planRun.id,
				"succeeded",
				PLAN_DEADLINE_MS,
			);
			assertEqual(
				finishedResumed.planRun.state,
				"succeeded",
				"second POST: plan-run reaches terminal 'succeeded'",
			);
			const skippedChild = finishedResumed.children.find((c) => c.seedId === SEED_B);
			if (skippedChild === undefined) {
				throw new AcceptanceError(`second POST: missing child for ${SEED_B}`);
			}
			assertEqual(
				skippedChild.state,
				"skipped",
				`second POST: ${SEED_B} flipped to 'skipped' without dispatching (resume semantics)`,
			);
			assertEqual(
				skippedChild.runId,
				null,
				`second POST: ${SEED_B} carries runId=null (no spawn happened)`,
			);
		} finally {
			if (handle !== undefined) {
				await handle.stop().catch(() => undefined);
			}
		}
	},
};

interface BuildPlanRunFixtureInput {
	readonly fixturePath: string;
	readonly sourceSamplePath: string;
	/** The shared harness git-config — its canopy + sample insteadOf entries get copied across. */
	readonly harnessGitConfigPath: string;
	readonly gitConfigPath: string;
	readonly projectGitUrl: string;
}

/**
 * Stand up a sibling fixture project mirroring the shared sample (same
 * burrow.toml + stub agent) plus committed `.seeds/{config.yaml,
 * issues.jsonl, plans.jsonl}` rows the API handler + coordinator read
 * on dispatch. Also writes a minimal git-config with an `insteadOf`
 * rewrite for PLAN_PROJECT_URL → fixturePath so warren's POST /projects
 * clone lands locally.
 */
async function buildPlanRunFixture(input: BuildPlanRunFixtureInput): Promise<void> {
	await mkdir(input.fixturePath, { recursive: true });
	await mkdir(join(input.fixturePath, "tools"), { recursive: true });
	await mkdir(join(input.fixturePath, ".seeds"), { recursive: true });

	const burrowToml = await readFile(join(input.sourceSamplePath, "burrow.toml"), "utf8");
	await writeFile(join(input.fixturePath, "burrow.toml"), burrowToml);
	await copyFile(
		join(input.sourceSamplePath, "tools", "stub-agent.sh"),
		join(input.fixturePath, "tools", "stub-agent.sh"),
	);
	// claude-code stub is the agent scenario 26 dispatches against — raw-text
	// stub-shell never emits a runtime-terminal envelope, so the bridge
	// would never finalize the child runs. The claude-stub emits a `result`
	// envelope that warren's `detectRuntimeTerminal` recognizes, letting
	// reap fire inline and the coordinator advance.
	await copyFile(
		join(input.sourceSamplePath, "tools", "claude-code-stub-agent.sh"),
		join(input.fixturePath, "tools", "claude-code-stub-agent.sh"),
	);
	await writeFile(
		join(input.fixturePath, "README.md"),
		"# warren acceptance plan-run fixture\n\nUsed by scripts/acceptance/scenarios/26-plan-run-roundtrip.ts.\n",
	);

	await writeFile(
		join(input.fixturePath, ".seeds", "config.yaml"),
		`project: "sample-plan-run"\nversion: "1"\nmax_plan_depth: 3\n`,
	);
	await writeFile(
		join(input.fixturePath, ".seeds", "issues.jsonl"),
		[seedRowOpen(SEED_A), seedRowOpen(SEED_B), seedRowOpen(SEED_C)].join(""),
	);
	await writeFile(join(input.fixturePath, ".seeds", "plans.jsonl"), planRow());

	const env = withGitIdentity();
	await runIn(input.fixturePath, ["git", "init", "--initial-branch=main"], env);
	await runIn(input.fixturePath, ["chmod", "+x", "tools/stub-agent.sh"], env);
	await runIn(input.fixturePath, ["chmod", "+x", "tools/claude-code-stub-agent.sh"], env);
	await runIn(input.fixturePath, ["git", "add", "."], env);
	await runIn(input.fixturePath, ["git", "commit", "-m", "init: plan-run acceptance fixture"], env);

	const harnessConfig = existsSync(input.harnessGitConfigPath)
		? await readFile(input.harnessGitConfigPath, "utf8")
		: "";
	const lines: string[] = [
		harnessConfig.trimEnd(),
		`[url "${input.fixturePath}"]`,
		`\tinsteadOf = ${input.projectGitUrl}`,
		"",
	];
	await writeFile(input.gitConfigPath, `${lines.join("\n")}\n`);
}

function seedRowOpen(id: string): string {
	const row = {
		id,
		title: `scenario-26 ${id}`,
		status: "open",
		type: "task",
		priority: 3,
		createdAt: SEED_TS,
		updatedAt: SEED_TS,
	};
	return `${JSON.stringify(row)}\n`;
}

function seedRowClosed(id: string): string {
	const row = {
		id,
		title: `scenario-26 ${id}`,
		status: "closed",
		type: "task",
		priority: 3,
		createdAt: SEED_TS,
		updatedAt: "2026-05-16T00:00:00.000Z",
	};
	return `${JSON.stringify(row)}\n`;
}

function planRow(): string {
	const plan = {
		id: PLAN_ID,
		seed: "warren-acc-26",
		template: "feature",
		status: "approved",
		revision: 1,
		sections: {
			context: "scenario-26 acceptance plan",
			approach: "dispatch three child seeds via the plan-run coordinator",
			steps: [
				{ title: `close ${SEED_A}` },
				{ title: `close ${SEED_B}` },
				{ title: `close ${SEED_C}` },
			],
		},
		children: [SEED_A, SEED_B, SEED_C],
		createdAt: SEED_TS,
		updatedAt: SEED_TS,
		name: "scenario-26 plan-run roundtrip",
	};
	return `${JSON.stringify(plan)}\n`;
}

async function rewriteSourceSeedClosed(fixturePath: string, seedId: string): Promise<void> {
	const seedsFile = join(fixturePath, ".seeds", "issues.jsonl");
	const body = existsSync(seedsFile) ? await readFile(seedsFile, "utf8") : "";
	const lines = body.split("\n").filter((l) => l.trim() !== "");
	const rewritten = lines.map((l) => {
		try {
			const parsed = JSON.parse(l) as { id?: unknown };
			if (typeof parsed.id === "string" && parsed.id === seedId) {
				return seedRowClosed(seedId).trim();
			}
		} catch {
			// keep unparseable rows as-is
		}
		return l;
	});
	await writeFile(seedsFile, `${rewritten.join("\n")}\n`);
	const env = withGitIdentity();
	await runIn(fixturePath, ["git", "add", "-A"], env);
	await runIn(
		fixturePath,
		["git", "commit", "-m", `scenario-26: close ${seedId} out of band`],
		env,
	);
}

async function waitForPlanState(
	http: WarrenHttp,
	planRunId: string,
	target: string,
	timeoutMs: number,
): Promise<PlanRunDetailResponse> {
	const start = Date.now();
	let last = "unknown";
	while (Date.now() - start < timeoutMs) {
		const row = await http.expectJson<PlanRunDetailResponse>(
			"GET",
			`/plan-runs/${encodeURIComponent(planRunId)}`,
			200,
		);
		last = row.planRun.state;
		if (row.planRun.state === target) return row;
		if (TERMINAL_PLAN_STATES.has(row.planRun.state)) {
			throw new AcceptanceError(
				`plan-run ${planRunId}: expected '${target}', reached terminal '${row.planRun.state}'`,
			);
		}
		await sleep(POLL_INTERVAL_MS);
	}
	throw new AcceptanceError(
		`plan-run ${planRunId} did not reach '${target}' within ${timeoutMs}ms (last state=${last})`,
	);
}

async function fetchAllPlanRunEvents(http: WarrenHttp, planRunId: string): Promise<EventRow[]> {
	const events: EventRow[] = [];
	for await (const row of http.streamNdjson(`/plan-runs/${encodeURIComponent(planRunId)}/events`)) {
		events.push(row as EventRow);
	}
	return events;
}

interface RunResult {
	stdout: string;
	stderr: string;
}

async function runIn(
	cwd: string,
	cmd: readonly string[],
	env: Record<string, string>,
): Promise<RunResult> {
	const proc = Bun.spawn({
		cmd: [...cmd],
		cwd,
		env,
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
			`scenario-26 command failed (${cmd.join(" ")} in ${cwd}): exit ${exitCode}\nstderr: ${stderr}\nstdout: ${stdout}`,
		);
	}
	return { stdout, stderr };
}

function withGitIdentity(): Record<string, string> {
	return {
		PATH: process.env.PATH ?? "",
		HOME: process.env.HOME ?? "/tmp",
		GIT_AUTHOR_NAME: "Warren Acceptance",
		GIT_AUTHOR_EMAIL: "acceptance@warren.invalid",
		GIT_COMMITTER_NAME: "Warren Acceptance",
		GIT_COMMITTER_EMAIL: "acceptance@warren.invalid",
	};
}

function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}
