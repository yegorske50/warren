/**
 * Errors specific to the warren server TOML config loader
 * (pl-9ba1 step 7 / warren-3909).
 *
 * The server-level TOML file is BOOT-CRITICAL infrastructure — unlike
 * per-project `.warren/` configs (which collect per-file errors so one
 * malformed file doesn't take down the server), a malformed
 * `warren.toml` MUST fail loudly so the operator notices before warren
 * starts serving requests. All failures surface as `ValidationError`
 * with a copy-paste recovery hint; the boot path catches the error,
 * prints it, and exits non-zero.
 */

export { ValidationError } from "../core/errors.ts";
