// Server-side `AgentSource` is `"builtin" | "library" | "project:<projectId>"`
// (src/registry/builtins/index.ts, R-03 / pl-fef5 step 2). The UI mirrors the
// shape on `AgentRow.source` but classifies on a coarser tier ("builtin" /
// "library" / "project") for badge rendering — operators care about the tier
// for triage, not the exact project id.

import type { AgentRow } from "@/api/types.ts";

export type AgentSourceTier = "builtin" | "library" | "project" | "unknown";

export interface ClassifiedAgentSource {
	tier: AgentSourceTier;
	label: string;
	projectId: string | null;
}

export function classifyAgentSource(
	source: AgentRow["source"] | undefined,
): ClassifiedAgentSource {
	if (source === undefined) return { tier: "unknown", label: "—", projectId: null };
	if (source === "builtin") return { tier: "builtin", label: "built-in", projectId: null };
	if (source === "library") return { tier: "library", label: "library", projectId: null };
	if (source.startsWith("project:")) {
		const id = source.slice("project:".length);
		return { tier: "project", label: "project", projectId: id.length > 0 ? id : null };
	}
	return { tier: "unknown", label: source, projectId: null };
}
