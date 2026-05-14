/**
 * Loader for the per-project `.warren/` directory (R-02).
 *
 * Contract (per pl-5d74 acceptance #2):
 *   missing file    → field is `null`, no entry in `errors`
 *   malformed file  → field is `null`, one entry in `errors`
 *   valid file      → field is the parsed value, no entry in `errors`
 *
 * Filesystem failures specific to a single file (read EACCES, EISDIR) are
 * surfaced as parse errors so a half-broken `.warren/` never throws past
 * this module — operators see "what's wrong" in the same envelope the UI
 * and doctor render. Unrecoverable errors (project clone vanished entirely)
 * still throw `WarrenConfigUnavailableError`; that's a host-level problem,
 * not config drift.
 *
 * I/O is injected so tests don't touch disk and so tooling can swap to a
 * git-tree reader if `.warren/` ever needs to load from non-checked-out
 * refs. Defaults to `node:fs/promises` + `js-yaml`.
 */

import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import yaml from "js-yaml";
import { type PrTemplateOverrides, parsePrTemplate } from "../runs/pr-template.ts";
import { WARREN_CONFIG_DIR, WARREN_CONFIG_FILES, warrenConfigRelativePath } from "./config.ts";
import {
	WARREN_CONFIG_FILE_ERROR_CODES,
	type WarrenConfigFileError,
	WarrenConfigUnavailableError,
} from "./errors.ts";
import {
	type DefaultsConfig,
	parseDefaultsConfig,
	parseTriggersConfig,
	type TriggersConfig,
} from "./schema.ts";

export interface LoadedWarrenConfig {
	/** Parsed triggers, or `null` when the file is absent or malformed. */
	readonly triggers: TriggersConfig | null;
	/** Parsed defaults, or `null` when the file is absent or malformed. */
	readonly defaults: DefaultsConfig | null;
	/**
	 * Per-fragment overrides parsed from `.warren/pr-template.md`
	 * (warren-bd49). `null` when the file is absent or its read failed;
	 * an empty object means the file exists but had no recognized
	 * fragments. Warnings (unknown fragment names, unclosed preview
	 * markers) surface via `errors` with `code: schemaError`.
	 */
	readonly prTemplate: PrTemplateOverrides | null;
	/** Per-file failures collected during this load. Empty on full success. */
	readonly errors: readonly WarrenConfigFileError[];
}

export type ReadFileFn = (path: string) => Promise<string>;
export type ExistsFn = (path: string) => boolean;

export interface LoadWarrenConfigInput {
	/** Absolute path to the project clone root (NOT the `.warren/` dir). */
	readonly projectPath: string;
	readonly readFile?: ReadFileFn;
	readonly exists?: ExistsFn;
}

export async function loadWarrenConfig(input: LoadWarrenConfigInput): Promise<LoadedWarrenConfig> {
	const { projectPath } = input;
	const exists = input.exists ?? existsSync;
	const read = input.readFile ?? defaultReadFile;

	if (!exists(projectPath)) {
		// A project whose clone vanished is a data-integrity issue surfaced
		// by src/projects/refresh.ts — repeat the same error class so the HTTP
		// layer can map both to a 503 with the same recovery hint.
		throw new WarrenConfigUnavailableError(`project clone missing on disk: ${projectPath}`, {
			recoveryHint: "DELETE /projects/:id and POST /projects to re-clone",
		});
	}

	const dirPath = join(projectPath, WARREN_CONFIG_DIR);
	const errors: WarrenConfigFileError[] = [];

	if (!exists(dirPath)) {
		// No `.warren/` at all is the bootstrap shape — existing projects keep
		// working unchanged. All fields null, no errors.
		return { triggers: null, defaults: null, prTemplate: null, errors };
	}

	const triggers = await loadTriggers({ projectPath, exists, read, errors });
	const defaults = await loadDefaults({ projectPath, exists, read, errors });
	const prTemplate = await loadPrTemplate({ projectPath, exists, read, errors });

	return { triggers, defaults, prTemplate, errors };
}

interface LoadOneInput {
	readonly projectPath: string;
	readonly exists: ExistsFn;
	readonly read: ReadFileFn;
	readonly errors: WarrenConfigFileError[];
}

async function loadTriggers(input: LoadOneInput): Promise<TriggersConfig | null> {
	const relPath = warrenConfigRelativePath("triggers");
	const absPath = join(input.projectPath, WARREN_CONFIG_DIR, WARREN_CONFIG_FILES.triggers);

	if (!input.exists(absPath)) {
		return null;
	}

	let raw: string;
	try {
		raw = await input.read(absPath);
	} catch (err) {
		input.errors.push({
			file: relPath,
			code: WARREN_CONFIG_FILE_ERROR_CODES.parseError,
			message: `failed to read file: ${formatError(err)}`,
		});
		return null;
	}

	let document: unknown;
	try {
		document = yaml.load(raw, { filename: relPath });
	} catch (err) {
		input.errors.push({
			file: relPath,
			code: WARREN_CONFIG_FILE_ERROR_CODES.parseError,
			message: `YAML parse error: ${formatError(err)}`,
		});
		return null;
	}

	const result = parseTriggersConfig(document);
	if (!result.ok) {
		input.errors.push({
			file: relPath,
			code: WARREN_CONFIG_FILE_ERROR_CODES.schemaError,
			message: result.message,
		});
		return null;
	}
	return result.value;
}

async function loadDefaults(input: LoadOneInput): Promise<DefaultsConfig | null> {
	const relPath = warrenConfigRelativePath("defaults");
	const absPath = join(input.projectPath, WARREN_CONFIG_DIR, WARREN_CONFIG_FILES.defaults);

	if (!input.exists(absPath)) {
		return null;
	}

	let raw: string;
	try {
		raw = await input.read(absPath);
	} catch (err) {
		input.errors.push({
			file: relPath,
			code: WARREN_CONFIG_FILE_ERROR_CODES.parseError,
			message: `failed to read file: ${formatError(err)}`,
		});
		return null;
	}

	const trimmed = raw.trim();
	let document: unknown;
	if (trimmed === "") {
		document = undefined;
	} else {
		try {
			document = JSON.parse(raw);
		} catch (err) {
			input.errors.push({
				file: relPath,
				code: WARREN_CONFIG_FILE_ERROR_CODES.parseError,
				message: `JSON parse error: ${formatError(err)}`,
			});
			return null;
		}
	}

	const result = parseDefaultsConfig(document);
	if (!result.ok) {
		input.errors.push({
			file: relPath,
			code: WARREN_CONFIG_FILE_ERROR_CODES.schemaError,
			message: result.message,
		});
		return null;
	}
	return result.value;
}

async function loadPrTemplate(input: LoadOneInput): Promise<PrTemplateOverrides | null> {
	const relPath = warrenConfigRelativePath("prTemplate");
	const absPath = join(input.projectPath, WARREN_CONFIG_DIR, WARREN_CONFIG_FILES.prTemplate);

	if (!input.exists(absPath)) {
		return null;
	}

	let raw: string;
	try {
		raw = await input.read(absPath);
	} catch (err) {
		input.errors.push({
			file: relPath,
			code: WARREN_CONFIG_FILE_ERROR_CODES.parseError,
			message: `failed to read file: ${formatError(err)}`,
		});
		return null;
	}

	const parsed = parsePrTemplate(raw);
	for (const warning of parsed.warnings) {
		input.errors.push({
			file: relPath,
			code: WARREN_CONFIG_FILE_ERROR_CODES.schemaError,
			message: warning.message,
		});
	}
	return parsed.overrides;
}

function defaultReadFile(path: string): Promise<string> {
	return readFile(path, "utf8");
}

function formatError(err: unknown): string {
	if (err instanceof Error) return err.message;
	return String(err);
}
