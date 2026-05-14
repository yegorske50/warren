/**
 * Static layout constants for the per-project `.warren/` directory (R-02).
 *
 * Unlike `src/projects/config.ts` and `src/registry/config.ts`, this module
 * has no env vars to resolve — `.warren/` lives at a fixed path inside each
 * project clone. The constants live here so file naming can shift in one
 * place without rippling through schema/loader/HTTP/UI.
 *
 * Format choices (locked by pl-5d74 step 1, mx-2cefdd):
 *   triggers.yaml    YAML — cron expressions read better there
 *   defaults.json    JSON — small, matches the rest of os-eco's UI/API
 *
 * Defaults deviates from the ROADMAP R-02 sketch (which proposed
 * defaults.yaml). The deviation is recorded as a decision; callers should
 * treat `defaults.json` as the canonical filename.
 */

export const WARREN_CONFIG_DIR = ".warren";

export const WARREN_CONFIG_FILES = {
	triggers: "triggers.yaml",
	defaults: "defaults.json",
	prTemplate: "pr-template.md",
} as const;

export type WarrenConfigFileKey = keyof typeof WARREN_CONFIG_FILES;

/** Project-relative path for a known config file (e.g. `.warren/triggers.yaml`). */
export function warrenConfigRelativePath(key: WarrenConfigFileKey): string {
	return `${WARREN_CONFIG_DIR}/${WARREN_CONFIG_FILES[key]}`;
}
