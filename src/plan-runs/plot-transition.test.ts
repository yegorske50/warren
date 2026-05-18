/**
 * Unit tests for the Plot auto-done helper (warren-b290 / pl-7937 step 5).
 * Stubs the `PlotStatusSetter` seam — the live `UserPlotClient.setStatus`
 * round-trip is asserted by scenario 27 (warren-97a3).
 */

import { describe, expect, test } from "bun:test";
import type { Logger } from "../server/types.ts";
import {
	type AutoTransitionResult,
	autoTransitionPlotToDone,
	type PlotStatusSetter,
	type SetPlotStatusToDoneInput,
} from "./plot-transition.ts";

interface CapturedLog {
	level: "info" | "warn" | "error";
	obj: object;
	msg: string | undefined;
}

function makeLogger(captured: CapturedLog[]): Logger {
	return {
		info(obj, msg) {
			captured.push({ level: "info", obj, msg });
		},
		warn(obj, msg) {
			captured.push({ level: "warn", obj, msg });
		},
		error(obj, msg) {
			captured.push({ level: "error", obj, msg });
		},
	};
}

function makeSetter(opts: {
	result?: AutoTransitionResult;
	throws?: unknown;
	calls?: SetPlotStatusToDoneInput[];
}): PlotStatusSetter {
	const calls = opts.calls ?? [];
	return {
		async setPlotStatusToDone(input) {
			calls.push(input);
			if ("throws" in opts) throw opts.throws;
			return opts.result ?? { kind: "transitioned", previousStatus: "active" };
		},
	};
}

describe("autoTransitionPlotToDone", () => {
	test("forwards inputs and logs info on transition", async () => {
		const calls: SetPlotStatusToDoneInput[] = [];
		const captured: CapturedLog[] = [];
		const result = await autoTransitionPlotToDone({
			setter: makeSetter({ calls }),
			logger: makeLogger(captured),
			plotDir: "/tmp/p/.plot",
			plotId: "plot_x",
			handle: "alice",
			planRunId: "plr_1",
		});
		expect(result.kind).toBe("transitioned");
		expect(calls).toEqual([{ plotDir: "/tmp/p/.plot", plotId: "plot_x", handle: "alice" }]);
		const info = captured.find((c) => c.msg === "plan_run.plot_auto_done");
		expect(info?.level).toBe("info");
	});

	test("returns skipped + warns when the Plot is not active", async () => {
		const captured: CapturedLog[] = [];
		const result = await autoTransitionPlotToDone({
			setter: makeSetter({ result: { kind: "skipped", currentStatus: "drafting" } }),
			logger: makeLogger(captured),
			plotDir: "/tmp/p/.plot",
			plotId: "plot_x",
			handle: "alice",
			planRunId: "plr_1",
		});
		expect(result).toEqual({ kind: "skipped", currentStatus: "drafting" });
		const warn = captured.find((c) => c.msg === "plan_run.plot_status_skipped");
		expect(warn?.level).toBe("warn");
		const obj = warn?.obj as { currentStatus?: string };
		expect(obj.currentStatus).toBe("drafting");
	});

	test("returns failed + warns when the setter throws", async () => {
		const captured: CapturedLog[] = [];
		const result = await autoTransitionPlotToDone({
			setter: makeSetter({ throws: new Error("boom") }),
			logger: makeLogger(captured),
			plotDir: "/tmp/p/.plot",
			plotId: "plot_x",
			handle: "alice",
			planRunId: "plr_1",
		});
		expect(result).toEqual({ kind: "failed", reason: "boom" });
		const warn = captured.find((c) => c.msg === "plan_run.plot_auto_done_failed");
		expect(warn?.level).toBe("warn");
		expect((warn?.obj as { err?: string }).err).toBe("boom");
	});

	test("stringifies a non-Error throw value", async () => {
		const captured: CapturedLog[] = [];
		const result = await autoTransitionPlotToDone({
			setter: makeSetter({ throws: "stringy" }),
			logger: makeLogger(captured),
			plotDir: "/tmp/p/.plot",
			plotId: "plot_x",
			handle: "alice",
			planRunId: "plr_1",
		});
		expect(result).toEqual({ kind: "failed", reason: "stringy" });
		const warn = captured.find((c) => c.msg === "plan_run.plot_auto_done_failed");
		expect((warn?.obj as { err?: string }).err).toBe("stringy");
	});
});
