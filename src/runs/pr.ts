/**
 * `openPullRequest` — open a GitHub PR for a branch reap just pushed
 * (warren-f6af). Fourth best-effort sub-step of `reapRun`, gated by
 * `WARREN_AUTO_OPEN_PR` (default on).
 *
 * The call hits the GitHub REST API directly (`POST /repos/:owner/:repo/pulls`)
 * via an injected `fetch` seam — no shell-out to `gh`, no extra runtime
 * dependency. Auth is `GITHUB_TOKEN`, the same token the supervisor wires
 * into git's `insteadOf` rule at boot (warren-dcf3).
 *
 * Failure shapes (callers translate into `reap_failed` events; reap never
 * crashes the run because the PR step blew up):
 *   - `missing_token` — `GITHUB_TOKEN` unset/empty. Skip cleanly.
 *   - `pr_exists`    — GitHub returns 422 because a PR already covers the
 *                       same head→base. Treated as success: re-fetch the
 *                       existing PR's `html_url` so the caller still gets
 *                       a link to surface (idempotency for re-runs and
 *                       restart-recovery sweeps).
 *   - `network`      — fetch threw or non-2xx response that isn't a
 *                       known idempotent shape.
 *
 * The body and title format is fixed in V1 — first prompt line as title,
 * full prompt + run id + warren UI link as body. Per-project templating
 * is out of scope (file a follow-up if needed).
 */

export interface OpenPullRequestInput {
	readonly owner: string;
	readonly repo: string;
	readonly head: string;
	readonly base: string;
	readonly title: string;
	readonly body: string;
	readonly token: string;
}

export type OpenPullRequestResult =
	| { readonly ok: true; readonly url: string; readonly mode: "created" | "exists" }
	| {
			readonly ok: false;
			readonly reason: "missing_token" | "network" | "http_error";
			readonly message: string;
	  };

export interface PrFetcher {
	readonly fetch: typeof fetch;
}

const GITHUB_API_BASE = "https://api.github.com";
const USER_AGENT = "warren-reap-pr-open";

export async function openPullRequest(
	input: OpenPullRequestInput,
	deps: PrFetcher = { fetch: globalThis.fetch },
): Promise<OpenPullRequestResult> {
	if (input.token === "") {
		return {
			ok: false,
			reason: "missing_token",
			message: "GITHUB_TOKEN unset; cannot open pull request",
		};
	}

	const url = `${GITHUB_API_BASE}/repos/${input.owner}/${input.repo}/pulls`;
	const headers = buildHeaders(input.token);

	let res: Response;
	try {
		res = await deps.fetch(url, {
			method: "POST",
			headers,
			body: JSON.stringify({
				title: input.title,
				body: input.body,
				head: input.head,
				base: input.base,
			}),
		});
	} catch (err) {
		return {
			ok: false,
			reason: "network",
			message: err instanceof Error ? err.message : String(err),
		};
	}

	if (res.status === 201) {
		const created = (await readJson(res)) as { html_url?: unknown } | null;
		const link = typeof created?.html_url === "string" ? created.html_url : null;
		if (link === null) {
			return { ok: false, reason: "http_error", message: "POST /pulls returned no html_url" };
		}
		return { ok: true, url: link, mode: "created" };
	}

	if (res.status === 422) {
		// 422 covers both "PR already exists" and "no commits between head and
		// base". The first is idempotent — fetch the existing PR and return
		// its url. The second is a no-op shape callers are expected to skip
		// upstream (commitsAhead === 0), but if it slips through we surface
		// the message so the operator sees why.
		const body = (await readJson(res)) as { errors?: unknown; message?: unknown } | null;
		const message = typeof body?.message === "string" ? body.message : "422 from POST /pulls";
		const errorsBlob = JSON.stringify(body?.errors ?? []);
		if (/already exists|pull request already exists/i.test(errorsBlob + message)) {
			const existing = await findExistingPr(input, deps);
			if (existing !== null) {
				return { ok: true, url: existing, mode: "exists" };
			}
			return {
				ok: false,
				reason: "http_error",
				message: "PR already exists but lookup did not return a url",
			};
		}
		return { ok: false, reason: "http_error", message };
	}

	const text = await readText(res);
	return {
		ok: false,
		reason: "http_error",
		message: `POST /pulls returned ${res.status}: ${truncate(text, 500)}`,
	};
}

async function findExistingPr(
	input: OpenPullRequestInput,
	deps: PrFetcher,
): Promise<string | null> {
	const params = new URLSearchParams({
		head: `${input.owner}:${input.head}`,
		base: input.base,
		state: "open",
		per_page: "1",
	});
	const url = `${GITHUB_API_BASE}/repos/${input.owner}/${input.repo}/pulls?${params.toString()}`;
	let res: Response;
	try {
		res = await deps.fetch(url, { method: "GET", headers: buildHeaders(input.token) });
	} catch {
		return null;
	}
	if (!res.ok) return null;
	const list = (await readJson(res)) as Array<{ html_url?: unknown }> | null;
	if (!Array.isArray(list) || list.length === 0) return null;
	const first = list[0];
	return typeof first?.html_url === "string" ? first.html_url : null;
}

function buildHeaders(token: string): Record<string, string> {
	return {
		accept: "application/vnd.github+json",
		authorization: `Bearer ${token}`,
		"content-type": "application/json",
		"user-agent": USER_AGENT,
		"x-github-api-version": "2022-11-28",
	};
}

async function readJson(res: Response): Promise<unknown> {
	try {
		return await res.json();
	} catch {
		return null;
	}
}

async function readText(res: Response): Promise<string> {
	try {
		return await res.text();
	} catch {
		return "";
	}
}

function truncate(input: string, max: number): string {
	return input.length <= max ? input : `${input.slice(0, max)}…`;
}

/* ----------------------------------------------------------------------- */
/* Title + body formatting                                                  */
/* ----------------------------------------------------------------------- */

const TITLE_MAX_LENGTH = 72;

export interface PrCommit {
	readonly sha: string;
	readonly subject: string;
}

export interface PrSeed {
	readonly id: string;
	readonly title: string;
}

export interface BuildPrContentInput {
	readonly prompt: string;
	readonly runId: string;
	readonly agentName: string;
	/** Optional warren UI base URL (e.g. `https://warren.example.com`). */
	readonly warrenBaseUrl?: string;
	/** Commits ahead of the base branch, oldest-first. */
	readonly commits?: readonly PrCommit[];
	/** Raw `git diff --stat <base>..HEAD` output (multi-line). */
	readonly diffStat?: string;
	/** Resolved seed referenced by the prompt (best-effort `sd show`). */
	readonly seed?: PrSeed;
	readonly startedAt?: string;
	readonly endedAt?: string;
	readonly costUsd?: number;
	readonly tokensInput?: number;
	readonly tokensOutput?: number;
	readonly tokensCacheRead?: number;
	/**
	 * Project opted into per-run preview environments (R-19 / SPEC §11.L).
	 * When true, the body includes a `preview_url_or_placeholder` fragment
	 * (a `## Preview` section bracketed by `<!-- warren:preview-start -->`
	 * and `<!-- warren:preview-end -->`) so reap's `pr_annotate_preview`
	 * sub-step can patch in the live URL once the sidecar is ready. False /
	 * absent renders no fragment — non-opted-in projects don't see preview
	 * scaffolding in their PR body.
	 */
	readonly previewOptedIn?: boolean;
}

/**
 * Markers `pr_annotate_preview` looks for when patching the live URL or
 * failure tail into the PR body (warren-f156). Exported so the annotator
 * can match without duplicating the literal — drift between the two
 * sides would silently break idempotency.
 */
export const PREVIEW_FRAGMENT_START = "<!-- warren:preview-start -->" as const;
export const PREVIEW_FRAGMENT_END = "<!-- warren:preview-end -->" as const;

export interface PrContent {
	readonly title: string;
	readonly body: string;
}

/**
 * Build the PR title and body (warren-9ee3).
 *
 * Title precedence — first non-empty wins:
 *   1. Resolved seed title (`seed.title`) when the prompt referenced a seed.
 *   2. First commit subject on the branch.
 *   3. First non-empty line of the prompt.
 *   4. `warren run <id> (<agent>)` fallback for empty prompts.
 *
 * Body sections (omitted when their data is absent):
 *   - Summary — first commit subject or `Agent <name> ran for <duration>; no commits.`
 *   - Run — warren UI link / agent / duration / cost
 *   - Seeds — `<id> — <title>` when a seed was resolved
 *   - Commits (N) — short-sha + subject bullets
 *   - Files changed — fenced block of `git diff --stat`
 *   - Prompt — collapsed `<details>` so the audit trail survives without dominating
 */
export function buildPrContent(input: BuildPrContentInput): PrContent {
	return { title: formatTitle(input), body: formatBody(input) };
}

function formatTitle(input: BuildPrContentInput): string {
	const raw = chooseTitleSource(input);
	return raw.length <= TITLE_MAX_LENGTH ? raw : `${raw.slice(0, TITLE_MAX_LENGTH - 1)}…`;
}

function chooseTitleSource(input: BuildPrContentInput): string {
	if (input.seed !== undefined && input.seed.title !== "") return input.seed.title;
	const firstCommit = input.commits?.[0];
	if (firstCommit !== undefined && firstCommit.subject !== "") return firstCommit.subject;
	const firstLine = input.prompt
		.split("\n")
		.map((l) => l.trim())
		.find((l) => l !== "");
	return firstLine ?? `warren run ${input.runId} (${input.agentName})`;
}

function formatBody(input: BuildPrContentInput): string {
	const sections: string[] = [];
	sections.push(formatSummarySection(input));
	sections.push(formatRunSection(input));
	if (input.seed !== undefined) sections.push(formatSeedsSection(input.seed));
	if (input.previewOptedIn === true) sections.push(formatPreviewSection());
	if (input.commits !== undefined && input.commits.length > 0) {
		sections.push(formatCommitsSection(input.commits));
	}
	if (input.diffStat !== undefined && input.diffStat.trim() !== "") {
		sections.push(formatFilesSection(input.diffStat));
	}
	sections.push(formatPromptSection(input.prompt));
	sections.push(formatFooter(input.runId));
	return sections.join("\n\n");
}

function formatPreviewSection(): string {
	return `## Preview\n\n${PREVIEW_FRAGMENT_START}\nPreview launching…\n${PREVIEW_FRAGMENT_END}`;
}

function formatSummarySection(input: BuildPrContentInput): string {
	const commits = input.commits;
	if (commits !== undefined && commits.length > 0) {
		return `## Summary\n\n${commits[0]?.subject ?? ""}`;
	}
	const duration = formatDuration(input.startedAt, input.endedAt);
	const tail = duration === null ? "no commits." : `for ${duration}; no commits.`;
	return `## Summary\n\nAgent \`${input.agentName}\` ran ${tail}`;
}

function formatRunSection(input: BuildPrContentInput): string {
	const lines = ["## Run", ""];
	const link =
		input.warrenBaseUrl !== undefined && input.warrenBaseUrl !== ""
			? `${input.warrenBaseUrl.replace(/\/+$/, "")}/#/runs/${input.runId}`
			: `\`${input.runId}\``;
	lines.push(`- **Warren run:** ${link}`);
	lines.push(`- **Agent:** ${input.agentName}`);
	const duration = formatDuration(input.startedAt, input.endedAt);
	if (duration !== null) lines.push(`- **Duration:** ${duration}`);
	const cost = formatCostLine(input);
	if (cost !== null) lines.push(`- **Cost:** ${cost}`);
	return lines.join("\n");
}

function formatSeedsSection(seed: PrSeed): string {
	return `## Seeds\n\n- ${seed.id} — ${seed.title}`;
}

function formatCommitsSection(commits: readonly PrCommit[]): string {
	const lines = [`## Commits (${commits.length})`, ""];
	for (const c of commits) {
		lines.push(`- ${shortSha(c.sha)} ${c.subject}`);
	}
	return lines.join("\n");
}

function formatFilesSection(diffStat: string): string {
	return `## Files changed\n\n\`\`\`\n${diffStat.trim()}\n\`\`\``;
}

function formatPromptSection(prompt: string): string {
	const body = prompt === "" ? "(empty prompt)" : prompt;
	return `## Prompt\n\n<details><summary>Show prompt</summary>\n\n\`\`\`\n${body}\n\`\`\`\n\n</details>`;
}

function formatFooter(runId: string): string {
	return `---\n\n🤖 Opened by warren run \`${runId}\``;
}

function shortSha(sha: string): string {
	return sha.length > 7 ? sha.slice(0, 7) : sha;
}

function formatDuration(startedAt: string | undefined, endedAt: string | undefined): string | null {
	if (startedAt === undefined || endedAt === undefined) return null;
	const start = Date.parse(startedAt);
	const end = Date.parse(endedAt);
	if (!Number.isFinite(start) || !Number.isFinite(end) || end < start) return null;
	const secs = Math.round((end - start) / 1000);
	if (secs < 60) return `${secs}s`;
	const m = Math.floor(secs / 60);
	const s = secs % 60;
	if (m < 60) return `${m}m ${s}s`;
	const h = Math.floor(m / 60);
	return `${h}h ${m % 60}m ${s}s`;
}

function formatCostLine(input: BuildPrContentInput): string | null {
	const parts: string[] = [];
	if (input.costUsd !== undefined) parts.push(formatCostUsd(input.costUsd));
	const tokens: string[] = [];
	if (input.tokensInput !== undefined) tokens.push(`${formatTokens(input.tokensInput)} in`);
	if (input.tokensOutput !== undefined) tokens.push(`${formatTokens(input.tokensOutput)} out`);
	if (input.tokensCacheRead !== undefined && input.tokensCacheRead > 0) {
		tokens.push(`${formatTokens(input.tokensCacheRead)} cache-r`);
	}
	if (tokens.length > 0) {
		const joined = tokens.join(" / ");
		parts.push(parts.length === 0 ? joined : `(${joined})`);
	}
	return parts.length === 0 ? null : parts.join(" ");
}

function formatCostUsd(cost: number): string {
	if (cost >= 1) return `$${cost.toFixed(2)}`;
	if (cost === 0) return "$0.00";
	return `$${cost.toFixed(3)}`;
}

function formatTokens(n: number): string {
	if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
	if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
	return String(n);
}

/* ----------------------------------------------------------------------- */
/* Config                                                                   */
/* ----------------------------------------------------------------------- */

export interface AutoOpenPrConfig {
	readonly enabled: boolean;
	readonly token: string;
	readonly warrenBaseUrl: string | null;
}

export type AutoOpenEnvLike = Readonly<Record<string, string | undefined>>;

/**
 * Resolve the auto-open config (warren-f6af). `WARREN_AUTO_OPEN_PR` defaults
 * to enabled — the seed's whole point is "agent run → reviewable change with
 * no manual hop". Anything that isn't a recognized falsy value (`0`, `false`,
 * `no`, `off`, case-insensitive, with whitespace tolerated) leaves it on, so
 * an operator can disable globally with `WARREN_AUTO_OPEN_PR=false` without
 * tripping a stricter parser.
 */
export function loadAutoOpenPrConfigFromEnv(env: AutoOpenEnvLike = process.env): AutoOpenPrConfig {
	const raw = env.WARREN_AUTO_OPEN_PR;
	const enabled = raw === undefined ? true : !isFalsy(raw);
	return {
		enabled,
		token: env.GITHUB_TOKEN ?? "",
		warrenBaseUrl: env.WARREN_BASE_URL ?? null,
	};
}

function isFalsy(raw: string): boolean {
	const v = raw.trim().toLowerCase();
	return v === "0" || v === "false" || v === "no" || v === "off" || v === "";
}
