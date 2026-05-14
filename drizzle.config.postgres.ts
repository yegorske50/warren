/**
 * Drizzle Kit config for the Postgres dialect (R-13, pl-f17e step 4).
 *
 * Mirrors `drizzle.config.sqlite.ts` against the pg physical schema. The
 * output folder is a sibling of the sqlite migration folder so the runtime
 * migrator (drizzle-orm/node-postgres/migrator) can find its journal via
 * `src/db/migrations/postgres/meta/_journal.json` — see `src/db/client.ts`
 * `DEFAULT_PG_MIGRATIONS_FOLDER`.
 *
 * The pg journal is independent from the sqlite journal: drizzle-kit
 * tracks dialect history per-snapshot, and pg has no analog of sqlite's
 * 12-step ALTER pattern (mx-9c90e8), so the histories don't translate
 * one-to-one. The CI parity gate (step 9 docs) enforces matching tags
 * going forward, not bytewise-identical SQL.
 */

import type { Config } from "drizzle-kit";

export default {
	schema: "./src/db/schema/postgres.ts",
	out: "./src/db/migrations/postgres",
	dialect: "postgresql",
} satisfies Config;
