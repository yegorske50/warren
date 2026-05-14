/**
 * Zod schema for warren's server-level TOML config
 * (pl-9ba1 step 7 / warren-3909).
 *
 * Step 7 lands the loader scaffolding in isolation so step 8
 * (warren-272c) can extend the schema with the `[workers]` block on a
 * tested foundation (pl-9ba1 risk #6). The schema is intentionally
 * `.strict()` and empty today: any unknown top-level key is rejected
 * with a structured ValidationError. When step 8 adds `workers`, it
 * grows the schema by one field — callers in step 9+ keep working
 * unchanged.
 *
 * `parseWarrenServerFileConfig` returns a discriminated result instead
 * of throwing. The loader (load.ts) decides which failures become
 * `ValidationError`; tests can exercise the parser in isolation.
 */

import { z } from "zod";

export const WarrenServerFileConfigSchema = z.object({}).strict();

export type WarrenServerFileConfig = z.infer<typeof WarrenServerFileConfigSchema>;

export type ParseResult<T> =
	| { readonly ok: true; readonly value: T }
	| { readonly ok: false; readonly message: string };

export function parseWarrenServerFileConfig(raw: unknown): ParseResult<WarrenServerFileConfig> {
	// An empty/missing-body file (Bun.TOML.parse on "" returns {}) is the
	// same as no config — operators may keep the file present as a stub
	// or for the documentation comments alone.
	if (raw === undefined || raw === null) {
		return { ok: true, value: {} };
	}
	const parsed = WarrenServerFileConfigSchema.safeParse(raw);
	if (parsed.success) {
		return { ok: true, value: parsed.data };
	}
	return { ok: false, message: parsed.error.issues.map(formatZodIssue).join("; ") };
}

function formatZodIssue(issue: z.core.$ZodIssue): string {
	const path = issue.path.length === 0 ? "<root>" : issue.path.join(".");
	return `${path}: ${issue.message}`;
}
