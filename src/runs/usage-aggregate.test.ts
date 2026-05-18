/**
 * Tests for the pure usage aggregator (warren-ab18).
 *
 * The shape sniffing here is exercised end-to-end through
 * `stream.test.ts` already; these tests target the standalone
 * aggregator entry point so the read-time hydrator (used by the
 * /runs/:id and /runs handlers) has direct coverage for the cases
 * `stream.test.ts` can't easily set up — mixed shapes, defensive
 * guards, and a no-events run.
 */

import { describe, expect, test } from "bun:test";
import {
	aggregateUsageFromEvents,
	eventRowToUsageInput,
	type UsageEventInput,
} from "./usage-aggregate.ts";

function piTurnEnd(opts: {
	input: number;
	output: number;
	costTotal: number;
	cacheRead?: number;
	cacheWrite?: number;
}): UsageEventInput {
	return {
		kind: "state_change",
		stream: "system",
		payload: {
			type: "turn_end",
			message: {
				usage: {
					input: opts.input,
					output: opts.output,
					cacheRead: opts.cacheRead ?? 0,
					cacheWrite: opts.cacheWrite ?? 0,
					cost: { total: opts.costTotal },
				},
			},
		},
	};
}

function claudeResult(opts: {
	inputTokens: number;
	outputTokens: number;
	totalCostUsd: number;
	cacheReadInputTokens?: number;
	cacheCreationInputTokens?: number;
}): UsageEventInput {
	return {
		kind: "state_change",
		stream: "system",
		payload: {
			type: "result",
			total_cost_usd: opts.totalCostUsd,
			usage: {
				input_tokens: opts.inputTokens,
				output_tokens: opts.outputTokens,
				cache_read_input_tokens: opts.cacheReadInputTokens ?? 0,
				cache_creation_input_tokens: opts.cacheCreationInputTokens ?? 0,
			},
		},
	};
}

describe("aggregateUsageFromEvents", () => {
	test("returns null when no usage envelopes present", () => {
		const stats = aggregateUsageFromEvents([
			{ kind: "text", stream: "stdout", payload: { text: "hello" } },
			{ kind: "tool_use", stream: "system", payload: { name: "Bash" } },
		]);
		expect(stats).toBeNull();
	});

	test("returns null on empty input", () => {
		expect(aggregateUsageFromEvents([])).toBeNull();
	});

	test("sums pi turn_end envelopes", () => {
		const stats = aggregateUsageFromEvents([
			piTurnEnd({ input: 100, output: 25, costTotal: 0.001 }),
			piTurnEnd({ input: 200, output: 50, costTotal: 0.002 }),
			piTurnEnd({ input: 300, output: 75, costTotal: 0.003 }),
		]);
		expect(stats).not.toBeNull();
		expect(stats?.costUsd).toBeCloseTo(0.006);
		expect(stats?.tokensInput).toBe(600);
		expect(stats?.tokensOutput).toBe(150);
	});

	test("assigns (not sums) claude-code result envelope", () => {
		// Claude-code emits cumulative totals once; if we accidentally
		// summed, two events would double the cost.
		const stats = aggregateUsageFromEvents([
			claudeResult({ inputTokens: 1200, outputTokens: 400, totalCostUsd: 0.0421 }),
		]);
		expect(stats).not.toBeNull();
		expect(stats?.costUsd).toBeCloseTo(0.0421);
		expect(stats?.tokensInput).toBe(1200);
		expect(stats?.tokensOutput).toBe(400);
	});

	test("pi wins when both shapes appear in the same stream", () => {
		// Mirrors the bridge's pi-wins parity at the terminal write
		// (stream.ts:297) — in practice a run is one runtime, but the
		// aggregator must agree with the bridge's choice when both
		// shapes happen to land.
		const stats = aggregateUsageFromEvents([
			piTurnEnd({ input: 100, output: 25, costTotal: 0.001 }),
			claudeResult({ inputTokens: 9999, outputTokens: 9999, totalCostUsd: 9.99 }),
		]);
		expect(stats?.costUsd).toBeCloseTo(0.001);
		expect(stats?.tokensInput).toBe(100);
	});

	test("ignores malformed pi turn_end with empty usage block", () => {
		const stats = aggregateUsageFromEvents([
			{
				kind: "state_change",
				stream: "system",
				payload: { type: "turn_end", message: { usage: {} } },
			},
		]);
		expect(stats).toBeNull();
	});

	test("ignores non-system streams", () => {
		const stats = aggregateUsageFromEvents([
			{
				kind: "state_change",
				stream: "stdout",
				payload: {
					type: "turn_end",
					message: { usage: { input: 100, output: 25, cost: { total: 0.5 } } },
				},
			},
		]);
		expect(stats).toBeNull();
	});

	test("ignores non-state_change kinds", () => {
		const stats = aggregateUsageFromEvents([
			{
				kind: "text",
				stream: "system",
				payload: {
					type: "turn_end",
					message: { usage: { input: 100, output: 25, cost: { total: 0.5 } } },
				},
			},
		]);
		expect(stats).toBeNull();
	});

	test("eventRowToUsageInput maps payloadJson to payload", () => {
		const row = {
			kind: "state_change",
			stream: "system" as const,
			payloadJson: { type: "result", total_cost_usd: 0.5, usage: { input_tokens: 10 } },
		};
		const stats = aggregateUsageFromEvents([eventRowToUsageInput(row)]);
		expect(stats?.costUsd).toBeCloseTo(0.5);
		expect(stats?.tokensInput).toBe(10);
	});
});
