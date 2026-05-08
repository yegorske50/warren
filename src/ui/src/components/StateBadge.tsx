import { Badge } from "@/components/ui/badge.tsx";
import type { RunState } from "@/api/types.ts";

export function StateBadge({ state }: { state: RunState }) {
	return <Badge variant={state}>{state}</Badge>;
}
