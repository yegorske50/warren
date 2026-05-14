/**
 * Scenario 20 — per-run preview environments end-to-end (R-19, pl-2c59 step 11).
 *
 * Plan pl-2c59's acceptance criterion #10:
 *   "Acceptance scenario 20 passes both variants (happy path + TTL eviction)
 *    against a live warren+burrow stack on Linux; macOS skip is documented
 *    (mx-1d31f0 pattern)."
 *
 * Two variants share one file — each boots its own warren+burrow stack with
 * a preview-enabled project fixture so the env knobs the variant cares about
 * (`WARREN_PREVIEW_IDLE_TTL`, `WARREN_PREVIEW_EVICTION_TICK_MS`) can be set
 * at boot. The fixture is built inside the scenario's own tmp dir from the
 * harness's sample-source clone plus a tiny `.warren/defaults.json` + a
 * portable preview command (`python3 -m http.server`), so the shared
 * harness fixture stays untouched and other scenarios are unaffected.
 *
 * ## Variant A — happy path
 *
 * Dispatch a run against a project with `preview` opted in, assert the run
 * succeeds and the 5th best-effort reap sub-step (`preview_launch`) lifts
 * the row to `preview_state='live'` with a `preview_port` assigned. Then
 * exercise the host reverse proxy preamble:
 *
 *   - `Host: run-<id>.<preview-host>` without a cookie → 401 (the proxy
 *     points the browser at `/runs/:id/preview/login`).
 *   - `GET /runs/:id/preview/login?token=…&redirect=…` → 302 + `Set-Cookie:
 *     warren_preview=…`.
 *   - Replay the same `Host` header with the issued cookie → 200; the
 *     upstream body proves the proxy forwarded into the sidecar.
 *
 * PR-open / annotate assertions are deferred: the harness's git-config
 * redirects push at a non-bare fixture clone with no GitHub remote, and
 * `pr_open` skips silently with `reap_failed` step=pr_open (scenario 09
 * has the same caveat / scope cut, warren-c37e). The launch path itself
 * is what this scenario locks down.
 *
 * ## Variant B — idle-TTL eviction
 *
 * Boot a separate stack with `WARREN_PREVIEW_IDLE_TTL=2s` and a fast
 * tick (`WARREN_PREVIEW_EVICTION_TICK_MS=500`). Dispatch a run, wait for
 * `preview_state='live'`, then **make no proxy requests** so
 * `preview_last_hit_at` stays null and the idle clock falls back to
 * `preview_started_at` (mx-…). Past the 2s window the eviction worker
 * transitions the row to `torn-down` and emits `preview_evicted` with
 * `reason='idle_ttl'`. Port released back to the allocator.
 *
 * ## Skip conditions
 *
 *   - **macOS** — burrow's bwrap-based inbound-port-forwarding (R-08, the
 *     transport the proxy depends on) is Linux-only. Seatbelt doesn't
 *     isolate the network namespace, so the host port the allocator
 *     hands out has nothing listening on it and the readiness probe
 *     times out. Documented in burrow's `inbound-forward.ts` and warren
 *     `mx-1d31f0`; same posture as scenarios 13/14.
 *   - **Postgres dialect** — the SPEC §11.L port allocator and eviction
 *     worker are sqlite-only today (R-13 follow-up, mx-b82a55). When the
 *     harness is dispatched with `WARREN_TEST_DIALECT=postgres` the
 *     scenario skips with a documented `pl-f17e` follow-up reference;
 *     the dialect-aware repo layer will light up the path under pg.
 */

import { randomBytes } from "node:crypto";
import { cp, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
	AcceptanceError,
	assertEqual,
	assertTrue,
	type Scenario,
	type ScenarioCtx,
	type ScenarioLogger,
	skipScenario,
} from "../lib/assert.ts";
import { WarrenHttp } from "../lib/http.ts";
import { type BootHandle, bootInProc } from "../lib/inproc.ts";

interface ProjectRow {
	readonly id: string;
	readonly gitUrl: string;
	readonly localPath: string;
}

interface RunRow {
	readonly id: string;
	readonly state: string;
	readonly burrowId: string | null;
	readonly previewState: "starting" | "live" | "failed" | "torn-down" | null;
	readonly previewPort: number | null;
	readonly previewFailureMessage: string | null;
}

interface CreateRunResponse {
	readonly run: RunRow;
}

interface EventRow {
	readonly id: number;
	readonly runId: string;
	readonly seq: number;
	readonly ts: string;
	readonly kind: string;
	readonly stream: string | null;
	readonly payload: Record<string, unknown> | null;
}

const POLL_INTERVAL_MS = 250;
/** Generous: the reap path runs branch_push (best-effort, skipped on push
 *  failure), then pr_open (best-effort, skipped without GITHUB_TOKEN),
 *  then preview_launch which spawns the sidecar and probes readiness for
 *  up to 60s. */
const LIVE_PREVIEW_TIMEOUT_MS = 90_000;
/** A run that never reaches a terminal state inside this window is treated
 *  as a harness failure — the stub agent exits in well under a second. */
const TERMINAL_TIMEOUT_MS = 30_000;
const TERMINAL_STATES = new Set(["succeeded", "failed", "cancelled"]);

const PREVIEW_HOST = "preview.warren.acceptance";
const PREVIEW_SANDBOX_PORT = 3000;
const PREVIEW_OK_BODY = "warren-preview-ok\n";

export const scenario: Scenario = {
	id: "20",
	title:
		"Preview environments — happy path + idle-TTL eviction (sqlite, Linux only; macOS skip per mx-1d31f0)",
	// Each variant boots its own warren+burrow; the supervisor lifecycle
	// hook isn't needed, but we use the harness's in-proc launcher (the
	// compose launcher doesn't expose the env-knob injection variant B
	// needs).
	modes: ["in-proc"],
	async run(ctx) {
		if (process.platform === "darwin") {
			skipScenario(
				"preview scenarios require burrow's Linux-only bwrap inbound-port-forwarding " +
					"(mx-1d31f0 / burrow inbound-forward.ts): Seatbelt doesn't isolate the network " +
					"namespace and the host port the allocator hands out has no listener.",
			);
		}
		const dialect = (process.env.WARREN_TEST_DIALECT ?? "sqlite").trim().toLowerCase();
		if (dialect === "postgres" || dialect === "postgresql") {
			skipScenario(
				"preview port allocator + eviction worker are sqlite-only today (mx-b82a55); " +
					"the pg path lights up under the R-13 dialect-aware repo follow-up (pl-f17e). " +
					"This scenario re-passes once that's wired.",
			);
		}

		await runVariantA(ctx);
		await runVariantB(ctx);
	},
};

/* ------------------------------------------------------------------ */
/* Variant A — happy path                                              */
/* ------------------------------------------------------------------ */

async function runVariantA(ctx: ScenarioCtx): Promise<void> {
	ctx.logger.info("scenario-20: variant A (happy path)");
	const variantRoot = await mkdtemp(join(tmpdir(), "warren-acceptance-20a-"));
	const sample = await buildPreviewProjectFixture({
		ctx,
		scenarioRoot: variantRoot,
		variantTag: "a",
	});

	let handle: BootHandle | undefined;
	try {
		handle = await bootInProc({
			tmpRoot: join(variantRoot, "warren"),
			token: ctx.token,
			canopyRepoUrl: ctx.fixtures.canopyRepoUrl,
			gitConfigPath: sample.gitConfigPath,
			extraEnv: {
				WARREN_STUB_SLEEP_MS: "0",
				// Long enough that the proxy 200/401 assertions don't race
				// the eviction worker; variant B owns the eviction path.
				WARREN_PREVIEW_HOST: PREVIEW_HOST,
				WARREN_PREVIEW_IDLE_TTL: "30m",
				WARREN_PREVIEW_MAX_LIFETIME: "8h",
				WARREN_PREVIEW_EVICTION_TICK_MS: "10000",
			},
		});
		ctx.logger.info(`scenario-20A: warren ready at ${handle.warrenUrl}`);

		const http = new WarrenHttp({ baseUrl: handle.warrenUrl, token: handle.token });
		await http.expectStatus("POST", "/agents/refresh", 200);
		const project = await ensureProject(http, sample.gitUrl);

		const created = await http.expectJson<CreateRunResponse>("POST", "/runs", 201, {
			body: {
				agent: ctx.fixtures.stubAgentName,
				project: project.id,
				prompt: "scenario-20 variant-A: preview happy-path",
			},
		});
		const runId = created.run.id;
		ctx.logger.debug(`scenario-20A: dispatched ${runId}`);

		await waitForRunTerminal(http, runId, ctx.logger);
		const live = await waitForPreviewState(http, runId, "live", LIVE_PREVIEW_TIMEOUT_MS);
		assertTrue(
			typeof live.previewPort === "number" && live.previewPort > 0,
			`preview_port populated on live preview (got ${JSON.stringify(live.previewPort)})`,
		);

		// The launch sub-step emits `preview_launched` once it observes a
		// 2xx readiness response; assert it lands and carries the allocated
		// port so reap event ordering stays observable.
		const events = await fetchEvents(http, runId);
		const launched = events.find((e) => e.kind === "preview_launched");
		if (launched === undefined) {
			throw new AcceptanceError(
				`expected a preview_launched event on run ${runId}; saw kinds=[${events
					.map((e) => e.kind)
					.join(", ")}]`,
			);
		}
		const launchedPort = (launched.payload as { port?: unknown } | null)?.port;
		assertEqual(
			launchedPort,
			live.previewPort,
			"preview_launched.payload.port matches the run row's preview_port",
		);

		// Proxy preamble: missing cookie → 401, login → 302+Set-Cookie,
		// replay with cookie → 200 with the sidecar's response body.
		const previewHostHeader = `run-${runId}.${PREVIEW_HOST}`;
		const noCookie = await proxyRequest({
			warrenUrl: handle.warrenUrl,
			hostHeader: previewHostHeader,
			path: "/",
		});
		if (noCookie.status !== 401) {
			throw new AcceptanceError(
				`proxy without cookie: expected 401, got ${noCookie.status} body=${noCookie.bodySnippet}`,
			);
		}

		const cookie = await loginAndIssueCookie({
			warrenUrl: handle.warrenUrl,
			token: handle.token,
			runId,
			previewHost: PREVIEW_HOST,
		});

		const withCookie = await proxyRequest({
			warrenUrl: handle.warrenUrl,
			hostHeader: previewHostHeader,
			path: "/",
			cookie,
		});
		if (withCookie.status !== 200) {
			throw new AcceptanceError(
				`proxy with cookie: expected 200, got ${withCookie.status} body=${withCookie.bodySnippet}`,
			);
		}
		// python3 -m http.server emits a directory index for `/`; assert
		// that it carries the marker file we committed so an accidental
		// upstream mis-route (e.g. proxy routing to a sibling port) fails
		// the assertion rather than silently passing on any 200.
		assertTrue(
			withCookie.bodySnippet.includes("preview-ok"),
			`expected proxied 200 to include 'preview-ok' marker, got ${JSON.stringify(
				withCookie.bodySnippet,
			)}`,
		);

		// Cleanup: manual teardown so the eviction worker doesn't have to
		// chase the sidecar after the variant's warren is killed.
		try {
			await http.request("POST", `/runs/${encodeURIComponent(runId)}/preview/teardown`, {
				body: { actor: "scenario-20A-cleanup" },
			});
		} catch {
			// Best-effort.
		}
	} finally {
		if (handle !== undefined) {
			await handle.stop().catch(() => undefined);
		}
	}
}

/* ------------------------------------------------------------------ */
/* Variant B — idle-TTL eviction                                       */
/* ------------------------------------------------------------------ */

async function runVariantB(ctx: ScenarioCtx): Promise<void> {
	ctx.logger.info("scenario-20: variant B (idle-TTL eviction)");
	const variantRoot = await mkdtemp(join(tmpdir(), "warren-acceptance-20b-"));
	const sample = await buildPreviewProjectFixture({
		ctx,
		scenarioRoot: variantRoot,
		variantTag: "b",
	});

	let handle: BootHandle | undefined;
	try {
		handle = await bootInProc({
			tmpRoot: join(variantRoot, "warren"),
			token: ctx.token,
			canopyRepoUrl: ctx.fixtures.canopyRepoUrl,
			gitConfigPath: sample.gitConfigPath,
			extraEnv: {
				WARREN_STUB_SLEEP_MS: "0",
				WARREN_PREVIEW_HOST: PREVIEW_HOST,
				// 2s idle TTL with a 500ms tick → eviction fires within
				// ~2.5s of the row reaching live (and no proxy hits land,
				// so the idle clock anchors to preview_started_at).
				WARREN_PREVIEW_IDLE_TTL: "2s",
				WARREN_PREVIEW_MAX_LIFETIME: "8h",
				WARREN_PREVIEW_EVICTION_TICK_MS: "500",
			},
		});
		ctx.logger.info(`scenario-20B: warren ready at ${handle.warrenUrl}`);

		const http = new WarrenHttp({ baseUrl: handle.warrenUrl, token: handle.token });
		await http.expectStatus("POST", "/agents/refresh", 200);
		const project = await ensureProject(http, sample.gitUrl);

		const created = await http.expectJson<CreateRunResponse>("POST", "/runs", 201, {
			body: {
				agent: ctx.fixtures.stubAgentName,
				project: project.id,
				prompt: "scenario-20 variant-B: idle-TTL eviction",
			},
		});
		const runId = created.run.id;
		ctx.logger.debug(`scenario-20B: dispatched ${runId}`);

		await waitForRunTerminal(http, runId, ctx.logger);
		const live = await waitForPreviewState(http, runId, "live", LIVE_PREVIEW_TIMEOUT_MS);
		const livePort = live.previewPort;
		assertTrue(
			typeof livePort === "number" && livePort > 0,
			`preview_port populated when live (got ${JSON.stringify(livePort)})`,
		);

		// Critical: NO proxy requests in variant B. The idle clock falls
		// back to preview_started_at so eviction fires deterministically
		// 2s after the launcher persists the live transition.
		const evicted = await waitForPreviewState(http, runId, "torn-down", 15_000);
		assertEqual(
			evicted.previewPort,
			null,
			"port released back to the allocator on idle eviction (preview_port=null)",
		);

		const events = await fetchEvents(http, runId);
		const evictionEvent = events.find((e) => e.kind === "preview_evicted");
		if (evictionEvent === undefined) {
			throw new AcceptanceError(
				`expected a preview_evicted event on run ${runId}; saw kinds=[${events
					.map((e) => e.kind)
					.join(", ")}]`,
			);
		}
		const payload = evictionEvent.payload as {
			reason?: unknown;
			port?: unknown;
			previousState?: unknown;
		} | null;
		assertEqual(
			payload?.reason,
			"idle_ttl",
			"preview_evicted.payload.reason is 'idle_ttl' (not max_lifetime or lru)",
		);
		assertEqual(
			payload?.port,
			livePort,
			"preview_evicted.payload.port carries the port the allocator just released",
		);
		assertEqual(
			payload?.previousState,
			"live",
			"preview_evicted.payload.previousState was 'live' before the worker flipped it",
		);
	} finally {
		if (handle !== undefined) {
			await handle.stop().catch(() => undefined);
		}
	}
}

/* ------------------------------------------------------------------ */
/* Fixture builder — preview-opted-in project source                   */
/* ------------------------------------------------------------------ */

interface BuildFixtureInput {
	readonly ctx: ScenarioCtx;
	readonly scenarioRoot: string;
	/** Suffix on the fake git URL so each variant's clone is isolated. */
	readonly variantTag: string;
}

interface BuiltPreviewFixture {
	readonly gitUrl: string;
	readonly sourceRepoPath: string;
	readonly gitConfigPath: string;
}

/**
 * Build a preview-enabled source repo by copying the harness's
 * `sample-source` clone into the scenario's tmp dir, dropping a
 * `.warren/defaults.json` with a `preview.command` that runs the
 * stdlib python http server, and committing the result on a fresh
 * branch. Returns a unique fake git URL + an augmented git-config that
 * redirects the URL onto the new on-disk repo.
 *
 * The harness's outer git-config is preserved verbatim (so the canopy
 * repo + the original sample URL keep resolving), with a single extra
 * `[url "..."].insteadOf` rule appended for our scenario-owned source.
 */
async function buildPreviewProjectFixture(input: BuildFixtureInput): Promise<BuiltPreviewFixture> {
	const sourceRepoPath = join(input.scenarioRoot, "sample-source");
	await cp(input.ctx.fixtures.sampleProjectPath, sourceRepoPath, { recursive: true });

	// .warren/defaults.json with a `preview` block opting the project in.
	// python3 -m http.server is on PATH on every supported Linux + macOS
	// runner, and the sandbox inherits PATH (PASSTHROUGH_ENV_KEYS in
	// inproc.ts). The `--directory` flag points it at a deterministic
	// dir containing a `preview-ok` marker so the proxy 200 assertion can
	// prove it actually round-tripped through the sidecar.
	const defaultsJson = JSON.stringify(
		{
			defaultRole: input.ctx.fixtures.stubAgentName,
			preview: {
				type: "server",
				command: `python3 -m http.server ${PREVIEW_SANDBOX_PORT} --bind 0.0.0.0 --directory ./.warren/preview-www`,
				port: PREVIEW_SANDBOX_PORT,
				readiness_path: "/",
			},
		},
		null,
		2,
	);
	await Bun.write(join(sourceRepoPath, ".warren", "defaults.json"), defaultsJson);
	await Bun.write(join(sourceRepoPath, ".warren", "preview-www", "index.html"), PREVIEW_OK_BODY);

	const suffix = `${input.variantTag}-${randomBytes(3).toString("hex")}`;
	const fakeUrl = `https://github.com/warren-acceptance/preview-sample-${suffix}.git`;

	await commitInSource(sourceRepoPath, `scenario-20: enable preview (${input.variantTag})`);

	const outerGitConfig = await readFile(join(input.ctx.tmp, "git-config"), "utf8");
	const extension = [
		`[url "${sourceRepoPath}"]`,
		`\tinsteadOf = ${fakeUrl}`,
		`[url "${sourceRepoPath}"]`,
		`\tinsteadOf = git@github.com:warren-acceptance/preview-sample-${suffix}.git`,
		"",
	].join("\n");
	const gitConfigPath = join(input.scenarioRoot, "git-config");
	await writeFile(gitConfigPath, `${outerGitConfig}\n${extension}`);

	return { gitUrl: fakeUrl, sourceRepoPath, gitConfigPath };
}

async function commitInSource(repoPath: string, message: string): Promise<void> {
	await runGit(repoPath, ["add", "."]);
	// Identity comes from GIT_AUTHOR_* / GIT_COMMITTER_* env vars set in
	// runGit — no fallthrough to the global [user] block (warren-9f70).
	await runGit(repoPath, ["commit", "-m", message]);
}

async function runGit(cwd: string, args: readonly string[]): Promise<void> {
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
			`git ${args.join(" ")} in ${cwd}: exit ${exitCode}\nstdout: ${stdout}\nstderr: ${stderr}`,
		);
	}
}

/* ------------------------------------------------------------------ */
/* HTTP helpers                                                         */
/* ------------------------------------------------------------------ */

async function ensureProject(http: WarrenHttp, gitUrl: string): Promise<ProjectRow> {
	const list = await http.expectJson<{ projects: ProjectRow[] }>("GET", "/projects", 200);
	const existing = list.projects.find((p) => p.gitUrl === gitUrl);
	if (existing !== undefined) return existing;
	return http.expectJson<ProjectRow>("POST", "/projects", 201, { body: { gitUrl } });
}

async function waitForRunTerminal(
	http: WarrenHttp,
	runId: string,
	logger: ScenarioLogger,
): Promise<void> {
	const deadline = Date.now() + TERMINAL_TIMEOUT_MS;
	let last = "<unknown>";
	while (Date.now() < deadline) {
		const row = await http.expectJson<RunRow>("GET", `/runs/${encodeURIComponent(runId)}`, 200);
		last = row.state;
		if (TERMINAL_STATES.has(row.state)) {
			logger.debug(`scenario-20: run ${runId} terminal in state=${row.state}`);
			if (row.state !== "succeeded") {
				throw new AcceptanceError(
					`expected run ${runId} to succeed (preview launches only on success); got state=${row.state}`,
				);
			}
			return;
		}
		await sleep(POLL_INTERVAL_MS);
	}
	throw new AcceptanceError(
		`run ${runId} did not reach terminal within ${TERMINAL_TIMEOUT_MS}ms (last state=${last})`,
	);
}

async function waitForPreviewState(
	http: WarrenHttp,
	runId: string,
	target: RunRow["previewState"],
	timeoutMs: number,
): Promise<RunRow> {
	const deadline = Date.now() + timeoutMs;
	let last: RunRow | undefined;
	while (Date.now() < deadline) {
		last = await http.expectJson<RunRow>("GET", `/runs/${encodeURIComponent(runId)}`, 200);
		if (last.previewState === target) return last;
		if (last.previewState === "failed") {
			throw new AcceptanceError(
				`preview transitioned to 'failed' before reaching '${target}' on run ${runId}: ` +
					`${last.previewFailureMessage ?? "<no message>"}`,
			);
		}
		await sleep(POLL_INTERVAL_MS);
	}
	throw new AcceptanceError(
		`preview did not reach '${target}' within ${timeoutMs}ms on run ${runId} ` +
			`(last preview_state=${JSON.stringify(last?.previewState ?? null)}, ` +
			`failure_message=${JSON.stringify(last?.previewFailureMessage ?? null)})`,
	);
}

async function fetchEvents(http: WarrenHttp, runId: string): Promise<EventRow[]> {
	const out: EventRow[] = [];
	for await (const env of http.streamNdjson(`/runs/${encodeURIComponent(runId)}/events`)) {
		out.push(env as EventRow);
	}
	return out;
}

/* ------------------------------------------------------------------ */
/* Proxy + login helpers                                                */
/* ------------------------------------------------------------------ */

interface ProxyRequestInput {
	readonly warrenUrl: string;
	readonly hostHeader: string;
	readonly path: string;
	readonly cookie?: string;
}

interface ProxyResponse {
	readonly status: number;
	readonly bodySnippet: string;
}

/**
 * Hit warren's HTTP port with a custom `Host:` header so the proxy
 * preamble matches `run-<id>.<host>` instead of running the normal
 * route pipeline. `fetch()` won't let us override `Host` in some
 * environments (Bun honors it; Node ignores it), so we go through the
 * lower-level fetch and pass the header explicitly. The harness boots
 * warren on Bun, which respects the header.
 */
async function proxyRequest(input: ProxyRequestInput): Promise<ProxyResponse> {
	const headers: Record<string, string> = { host: input.hostHeader };
	if (input.cookie !== undefined) headers.cookie = input.cookie;
	const res = await fetch(`${input.warrenUrl}${input.path}`, {
		method: "GET",
		headers,
		redirect: "manual",
	});
	const text = await res.text();
	return {
		status: res.status,
		bodySnippet: text.length > 512 ? `${text.slice(0, 512)}…` : text,
	};
}

interface LoginInput {
	readonly warrenUrl: string;
	readonly token: string;
	readonly runId: string;
	readonly previewHost: string;
}

/**
 * Walk the `/runs/:id/preview/login?token=…&redirect=…` handshake and
 * return the value of the `warren_preview` cookie the handler issues.
 * The handler responds 302 with `Set-Cookie`; we don't follow the
 * redirect (the cookie scope makes it impossible to actually reach
 * `run-<id>.<host>` from a test process anyway).
 */
async function loginAndIssueCookie(input: LoginInput): Promise<string> {
	const redirect = `https://run-${input.runId}.${input.previewHost}/`;
	const url = `${input.warrenUrl}/runs/${encodeURIComponent(input.runId)}/preview/login?token=${encodeURIComponent(
		input.token,
	)}&redirect=${encodeURIComponent(redirect)}`;
	const res = await fetch(url, { method: "GET", redirect: "manual" });
	if (res.status !== 302) {
		const body = await res.text();
		throw new AcceptanceError(
			`preview login: expected 302, got ${res.status}: ${body.slice(0, 256)}`,
		);
	}
	const setCookie = res.headers.get("set-cookie");
	if (setCookie === null || setCookie.length === 0) {
		throw new AcceptanceError("preview login: missing Set-Cookie on 302");
	}
	const value = parseSetCookie(setCookie, "warren_preview");
	if (value === null) {
		throw new AcceptanceError(
			`preview login: Set-Cookie did not carry a warren_preview entry: ${setCookie}`,
		);
	}
	return `warren_preview=${value}`;
}

function parseSetCookie(setCookie: string, name: string): string | null {
	// Bun's `headers.get("set-cookie")` returns the cookie line verbatim
	// (we issue exactly one); the cookie value is everything between the
	// `<name>=` prefix and the first `;` attribute separator.
	const eq = setCookie.indexOf("=");
	if (eq === -1) return null;
	if (setCookie.slice(0, eq).trim() !== name) return null;
	const tail = setCookie.slice(eq + 1);
	const semi = tail.indexOf(";");
	return semi === -1 ? tail : tail.slice(0, semi);
}

function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}
