import { describe, expect, test } from "bun:test";
import {
	DefaultsConfigSchema,
	parseDefaultsConfig,
	parseTriggersConfig,
	TriggersConfigSchema,
} from "./schema.ts";

const VALID_TRIGGER = {
	id: "nightly-refactor",
	kind: "cron",
	cron: "0 3 * * *",
	timezone: "UTC",
	seed: "seeds-abc1",
	role: "refactor-bot",
};

describe("TriggersConfigSchema", () => {
	test("accepts an array of cron triggers", () => {
		const parsed = TriggersConfigSchema.safeParse([VALID_TRIGGER]);
		expect(parsed.success).toBe(true);
	});

	test("accepts the optional 6-field cron form (seconds first)", () => {
		const parsed = TriggersConfigSchema.safeParse([{ ...VALID_TRIGGER, cron: "0 0 3 * * *" }]);
		expect(parsed.success).toBe(true);
	});

	test("rejects unknown kinds (preserves room for future webhook triggers)", () => {
		const parsed = TriggersConfigSchema.safeParse([{ ...VALID_TRIGGER, kind: "webhook" }]);
		expect(parsed.success).toBe(false);
	});

	test("rejects strict-extra fields so typos surface loudly", () => {
		const parsed = TriggersConfigSchema.safeParse([{ ...VALID_TRIGGER, oops: 1 }]);
		expect(parsed.success).toBe(false);
	});

	test("rejects malformed cron expressions", () => {
		const parsed = TriggersConfigSchema.safeParse([{ ...VALID_TRIGGER, cron: "every minute" }]);
		expect(parsed.success).toBe(false);
	});

	test("rejects duplicate trigger ids", () => {
		const parsed = TriggersConfigSchema.safeParse([VALID_TRIGGER, VALID_TRIGGER]);
		expect(parsed.success).toBe(false);
	});

	test("rejects ids that aren't kebab/snake-case", () => {
		const parsed = TriggersConfigSchema.safeParse([{ ...VALID_TRIGGER, id: "Nightly Job" }]);
		expect(parsed.success).toBe(false);
	});
});

describe("parseTriggersConfig", () => {
	test("treats null/undefined as an empty trigger list", () => {
		expect(parseTriggersConfig(null)).toEqual({ ok: true, value: [] });
		expect(parseTriggersConfig(undefined)).toEqual({ ok: true, value: [] });
	});

	test("returns ok=true with parsed entries on success", () => {
		const result = parseTriggersConfig([VALID_TRIGGER]);
		expect(result.ok).toBe(true);
		if (result.ok) {
			expect(result.value).toHaveLength(1);
			expect(result.value[0]?.id).toBe("nightly-refactor");
		}
	});

	test("returns ok=false with a joined message on failure (no throw)", () => {
		const result = parseTriggersConfig([{ ...VALID_TRIGGER, cron: "" }]);
		expect(result.ok).toBe(false);
		if (!result.ok) {
			expect(result.message).toMatch(/cron/);
		}
	});
});

describe("DefaultsConfigSchema", () => {
	test("accepts the full shape", () => {
		const parsed = DefaultsConfigSchema.safeParse({
			defaultRole: "claude-code",
			defaultBranch: "main",
			defaultPrompt: "Read the issue, plan, execute.",
			defaultProvider: "anthropic",
			defaultModel: "claude-opus-4-7",
			runBranchPrefix: "warren",
		});
		expect(parsed.success).toBe(true);
	});

	test("accepts an empty object (operators may keep the file as documentation)", () => {
		const parsed = DefaultsConfigSchema.safeParse({});
		expect(parsed.success).toBe(true);
	});

	test("rejects extra fields so typos surface loudly", () => {
		const parsed = DefaultsConfigSchema.safeParse({ defaultRoll: "claude-code" });
		expect(parsed.success).toBe(false);
	});

	test("rejects empty-string overrides", () => {
		expect(DefaultsConfigSchema.safeParse({ defaultRole: "" }).success).toBe(false);
		expect(DefaultsConfigSchema.safeParse({ defaultBranch: "" }).success).toBe(false);
		expect(DefaultsConfigSchema.safeParse({ defaultPrompt: "" }).success).toBe(false);
		expect(DefaultsConfigSchema.safeParse({ defaultProvider: "" }).success).toBe(false);
		expect(DefaultsConfigSchema.safeParse({ defaultModel: "" }).success).toBe(false);
		expect(DefaultsConfigSchema.safeParse({ runBranchPrefix: "" }).success).toBe(false);
	});

	test("rejects role names that aren't canopy-shaped", () => {
		const parsed = DefaultsConfigSchema.safeParse({ defaultRole: "Refactor Bot" });
		expect(parsed.success).toBe(false);
	});

	test("rejects runBranchPrefix that contains slashes or other invalid chars (warren-9993)", () => {
		expect(DefaultsConfigSchema.safeParse({ runBranchPrefix: "bot/agent" }).success).toBe(false);
		expect(DefaultsConfigSchema.safeParse({ runBranchPrefix: "Warren" }).success).toBe(false);
		expect(DefaultsConfigSchema.safeParse({ runBranchPrefix: ".warren" }).success).toBe(false);
		expect(DefaultsConfigSchema.safeParse({ runBranchPrefix: "warren agent" }).success).toBe(false);
	});

	test("accepts kebab-case runBranchPrefix (warren-9993)", () => {
		expect(DefaultsConfigSchema.safeParse({ runBranchPrefix: "warren" }).success).toBe(true);
		expect(DefaultsConfigSchema.safeParse({ runBranchPrefix: "agent-1" }).success).toBe(true);
		expect(DefaultsConfigSchema.safeParse({ runBranchPrefix: "bot.fix" }).success).toBe(true);
	});
});

describe("parseDefaultsConfig", () => {
	test("treats null/undefined as an empty defaults block", () => {
		expect(parseDefaultsConfig(null)).toEqual({ ok: true, value: {} });
		expect(parseDefaultsConfig(undefined)).toEqual({ ok: true, value: {} });
	});

	test("returns ok=false on schema failure (no throw)", () => {
		const result = parseDefaultsConfig({ defaultBranch: 42 });
		expect(result.ok).toBe(false);
	});
});
