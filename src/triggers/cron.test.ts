import { describe, expect, test } from "bun:test";
import { parseCron } from "./cron.ts";

describe("parseCron", () => {
	test("parses a standard 5-token expression", () => {
		const result = parseCron({ expression: "0 0 * * *" });
		expect(result.ok).toBe(true);
		if (!result.ok) return;
		const next = result.cron.nextRun(new Date("2026-05-10T12:00:00.000Z"));
		expect(next?.toISOString()).toBe("2026-05-11T00:00:00.000Z");
	});

	test("parses a 6-token expression (seconds-precision)", () => {
		const result = parseCron({ expression: "0 0 0 * * *" });
		expect(result.ok).toBe(true);
		if (!result.ok) return;
		const next = result.cron.nextRun(new Date("2026-05-10T12:00:00.000Z"));
		expect(next?.toISOString()).toBe("2026-05-11T00:00:00.000Z");
	});

	test("honors the per-trigger timezone", () => {
		// Midnight UTC vs midnight America/New_York give different absolute
		// instants — proves the tz field reaches croner rather than being
		// silently UTC.
		const utc = parseCron({ expression: "0 0 * * *", timezone: "UTC" });
		const ny = parseCron({ expression: "0 0 * * *", timezone: "America/New_York" });
		expect(utc.ok && ny.ok).toBe(true);
		if (!utc.ok || !ny.ok) return;
		const ref = new Date("2026-05-10T12:00:00.000Z");
		expect(utc.cron.nextRun(ref)?.toISOString()).not.toBe(ny.cron.nextRun(ref)?.toISOString());
	});

	test("returns { ok: false } for an unparseable expression", () => {
		const result = parseCron({ expression: "not a cron" });
		expect(result.ok).toBe(false);
	});

	test("returns { ok: false } for an unknown timezone", () => {
		const result = parseCron({ expression: "0 0 * * *", timezone: "Not/A_Real_Zone" });
		expect(result.ok).toBe(false);
	});

	test("previousRun returns the most recent past slot", () => {
		const result = parseCron({ expression: "0 * * * *" }); // hourly at :00
		expect(result.ok).toBe(true);
		if (!result.ok) return;
		const prev = result.cron.previousRun(new Date("2026-05-10T12:30:00.000Z"));
		expect(prev?.toISOString()).toBe("2026-05-10T12:00:00.000Z");
	});
});
