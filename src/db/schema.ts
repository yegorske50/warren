/**
 * Back-compat re-export shim for warren's schema (R-13, pl-f17e step 2).
 *
 * The dialect split lives under `./schema/`:
 *
 *   - `./schema/columns.ts`  — dialect-agnostic constants (enum tuples, type
 *                              unions, table/index name strings).
 *   - `./schema/sqlite.ts`   — sqliteTable definitions; today's runtime.
 *   - `./schema/postgres.ts` — pgTable mirror; lit up by step 3 (warren-a66e).
 *
 * Repos and consumers import `agents` / `runs` / `RunRow` / `RUN_STATES` /
 * etc. from this file — re-exporting the SQLite tables here preserves every
 * existing import. The dialect-aware client (step 3) will switch consumers
 * to import the dialect-specific module directly; until then the SQLite
 * objects ARE the runtime.
 */

export * from "./schema/columns.ts";
export * from "./schema/sqlite.ts";
