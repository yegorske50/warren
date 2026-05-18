import { Badge } from "@/components/ui/badge.tsx";
import type { PlanRunChildState, PlanRunState } from "@/api/types.ts";

type StateBadgeVariant =
	| "default"
	| "secondary"
	| "running"
	| "queued"
	| "succeeded"
	| "failed"
	| "cancelled";

const PLAN_RUN_VARIANT: Record<PlanRunState, StateBadgeVariant> = {
	queued: "queued",
	running: "running",
	succeeded: "succeeded",
	failed: "failed",
	cancelled: "cancelled",
};

const PLAN_RUN_CHILD_VARIANT: Record<PlanRunChildState, StateBadgeVariant> = {
	pending: "secondary",
	dispatched: "queued",
	running: "running",
	pr_open: "queued",
	merged: "succeeded",
	failed: "failed",
	skipped: "cancelled",
};

export function PlanRunStateBadge({ state }: { state: PlanRunState }) {
	return (
		<Badge variant={PLAN_RUN_VARIANT[state]} className="font-mono text-xs">
			{state}
		</Badge>
	);
}

export function PlanRunChildStateBadge({ state }: { state: PlanRunChildState }) {
	return (
		<Badge variant={PLAN_RUN_CHILD_VARIANT[state]} className="font-mono text-xs">
			{state}
		</Badge>
	);
}
