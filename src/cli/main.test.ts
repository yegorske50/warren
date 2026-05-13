import { describe, expect, test } from "bun:test";
import { buildProgram } from "./main.ts";
import type { CliContext } from "./output.ts";

function silentContext(): CliContext {
	return {
		env: {},
		stdio: {
			stdout: { write: () => undefined },
			stderr: { write: () => undefined },
		},
		spawn: async () => ({ stdout: "", stderr: "", exitCode: 0 }),
	};
}

describe("buildProgram", () => {
	test("registers all SPEC §8.2 subcommands + the `init` scaffolder", () => {
		const program = buildProgram(silentContext());
		const names = program.commands.map((c) => c.name()).sort();
		expect(names).toEqual(["add-project", "doctor", "init", "register-agent", "run", "serve"]);
	});

	test("--version reports the package VERSION constant", () => {
		const program = buildProgram(silentContext());
		// Commander surfaces version via .version() which is the same string from src/index.ts.
		expect(program.version()).toMatch(/^\d+\.\d+\.\d+$/);
	});

	test("`run` requires a --prompt option", () => {
		const program = buildProgram(silentContext());
		const runCmd = program.commands.find((c) => c.name() === "run");
		expect(runCmd).toBeDefined();
		const promptOpt = runCmd?.options.find((o) => o.long === "--prompt");
		expect(promptOpt?.mandatory).toBe(true);
	});
});
