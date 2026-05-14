/**
 * Drizzle Kit config for the SQLite dialect (R-13, pl-f17e step 4).
 *
 * Points at the dialect-specific schema module (`src/db/schema/sqlite.ts`)
 * rather than the re-export shim (`src/db/schema.ts`) so drizzle-kit only
 * sees one set of tables — the shim would otherwise expose both the sqlite
 * runtime tables and (transitively via columns.ts) duplicates that confuse
 * `drizzle-kit generate`.
 *
 * Output is the existing flat folder so the 0000_init … 0008 history that
 * production operators have already applied stays bit-stable; do not rename
 * or reflow these files. New migrations land here via
 * `bun run db:generate:sqlite` and must be twinned by `db:generate:postgres`
 * (acceptance #7 migration parity lint).
 */

import type { Config } from "drizzle-kit";

export default {
	schema: "./src/db/schema/sqlite.ts",
	out: "./src/db/migrations",
	dialect: "sqlite",
} satisfies Config;
