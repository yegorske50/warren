import { useQuery } from "@tanstack/react-query";
import { useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { agentsApi, projectsApi, runsApi } from "@/api/client.ts";
import { StateBadge } from "@/components/StateBadge.tsx";
import { Button } from "@/components/ui/button.tsx";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card.tsx";
import {
	Table,
	TableBody,
	TableCell,
	TableHead,
	TableHeader,
	TableRow,
} from "@/components/ui/table.tsx";
import { relativeTime } from "@/lib/utils.ts";

type Filter = "all" | { kind: "agent"; value: string } | { kind: "project"; value: string };

export function RunsPage() {
	const [filter, setFilter] = useState<Filter>("all");

	const filterApi = filter === "all" ? {} : { [filter.kind]: filter.value };
	const runs = useQuery({
		queryKey: ["runs", filter],
		queryFn: ({ signal }) => runsApi.list(filterApi, signal),
		refetchInterval: 5000,
	});
	const agents = useQuery({
		queryKey: ["agents"],
		queryFn: ({ signal }) => agentsApi.list(signal),
	});
	const projects = useQuery({
		queryKey: ["projects"],
		queryFn: ({ signal }) => projectsApi.list(signal),
	});

	const projectIndex = useMemo(() => {
		const m = new Map<string, string>();
		for (const p of projects.data?.projects ?? []) m.set(p.id, p.gitUrl);
		return m;
	}, [projects.data]);

	return (
		<div className="space-y-6">
			<header className="flex flex-wrap items-center justify-between gap-4">
				<div>
					<h1 className="text-2xl font-semibold tracking-tight">Runs</h1>
					<p className="text-sm text-(--color-muted-foreground)">
						Agent runs dispatched into burrow sandboxes.
					</p>
				</div>
				<Link to="/runs/new">
					<Button>Dispatch a run</Button>
				</Link>
			</header>

			<div className="flex flex-wrap gap-2">
				<FilterPill
					active={filter === "all"}
					label="All"
					onClick={() => setFilter("all")}
				/>
				{agents.data?.agents.map((a) => (
					<FilterPill
						key={`a-${a.name}`}
						active={filter !== "all" && filter.kind === "agent" && filter.value === a.name}
						label={`agent: ${a.name}`}
						onClick={() => setFilter({ kind: "agent", value: a.name })}
					/>
				))}
				{projects.data?.projects.map((p) => (
					<FilterPill
						key={`p-${p.id}`}
						active={filter !== "all" && filter.kind === "project" && filter.value === p.id}
						label={`project: ${p.gitUrl.replace(/^https:\/\/github\.com\//, "")}`}
						onClick={() => setFilter({ kind: "project", value: p.id })}
					/>
				))}
			</div>

			<Card>
				<CardHeader>
					<CardTitle>{runs.data?.runs.length ?? 0} runs</CardTitle>
				</CardHeader>
				<CardContent className="p-0">
					{runs.isLoading ? (
						<p className="p-6 text-sm text-(--color-muted-foreground)">Loading…</p>
					) : runs.isError ? (
						<p className="p-6 text-sm text-(--color-destructive)">
							{runs.error instanceof Error ? runs.error.message : String(runs.error)}
						</p>
					) : runs.data?.runs.length === 0 ? (
						<p className="p-6 text-sm text-(--color-muted-foreground)">
							No runs match this filter. Dispatch one above.
						</p>
					) : (
						<Table>
							<TableHeader>
								<TableRow>
									<TableHead>State</TableHead>
									<TableHead>ID</TableHead>
									<TableHead>Agent</TableHead>
									<TableHead>Project</TableHead>
									<TableHead>Started</TableHead>
								</TableRow>
							</TableHeader>
							<TableBody>
								{runs.data?.runs.map((r) => (
									<TableRow key={r.id}>
										<TableCell>
											<StateBadge state={r.state} />
										</TableCell>
										<TableCell>
											<Link
												to={`/runs/${encodeURIComponent(r.id)}`}
												className="font-mono text-xs underline-offset-2 hover:underline"
											>
												{r.id}
											</Link>
										</TableCell>
										<TableCell>{r.agentName}</TableCell>
										<TableCell className="font-mono text-xs">
											{projectIndex.get(r.projectId) ?? r.projectId}
										</TableCell>
										<TableCell className="text-(--color-muted-foreground)">
											{relativeTime(r.startedAt)}
										</TableCell>
									</TableRow>
								))}
							</TableBody>
						</Table>
					)}
				</CardContent>
			</Card>
		</div>
	);
}

function FilterPill({
	active,
	label,
	onClick,
}: {
	active: boolean;
	label: string;
	onClick: () => void;
}) {
	return (
		<button
			type="button"
			onClick={onClick}
			className={`rounded-full border px-3 py-1 text-xs transition-colors ${
				active
					? "bg-(--color-primary) text-(--color-primary-foreground)"
					: "bg-(--color-card) hover:bg-(--color-accent)"
			}`}
		>
			{label}
		</button>
	);
}
