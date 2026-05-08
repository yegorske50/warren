import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { agentsApi, projectsApi, runsApi } from "@/api/client.ts";
import { Button } from "@/components/ui/button.tsx";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card.tsx";
import { Label } from "@/components/ui/label.tsx";
import { Textarea } from "@/components/ui/textarea.tsx";

export function NewRunPage() {
	const navigate = useNavigate();
	const qc = useQueryClient();
	const agents = useQuery({
		queryKey: ["agents"],
		queryFn: ({ signal }) => agentsApi.list(signal),
	});
	const projects = useQuery({
		queryKey: ["projects"],
		queryFn: ({ signal }) => projectsApi.list(signal),
	});

	const [agent, setAgent] = useState("");
	const [project, setProject] = useState("");
	const [prompt, setPrompt] = useState("");

	const spawn = useMutation({
		mutationFn: (input: { agent: string; project: string; prompt: string }) =>
			runsApi.create(input),
		onSuccess: (data) => {
			qc.invalidateQueries({ queryKey: ["runs"] });
			navigate(`/runs/${encodeURIComponent(data.run.id)}`);
		},
	});

	const handleSubmit = (e: React.FormEvent): void => {
		e.preventDefault();
		if (agent.length === 0 || project.length === 0 || prompt.trim().length === 0) return;
		spawn.mutate({ agent, project, prompt });
	};

	const noAgents = !agents.isLoading && (agents.data?.agents.length ?? 0) === 0;
	const noProjects = !projects.isLoading && (projects.data?.projects.length ?? 0) === 0;

	return (
		<div className="mx-auto max-w-3xl space-y-6">
			<header>
				<h1 className="text-2xl font-semibold tracking-tight">Dispatch run</h1>
				<p className="text-sm text-(--color-muted-foreground)">
					Spawn a canopy agent against a project repo inside a fresh burrow sandbox.
				</p>
			</header>

			{noAgents ? (
				<Card>
					<CardContent className="p-4 text-sm text-(--color-destructive)">
						No agents registered. Visit <strong>Agents</strong> and click{" "}
						<strong>Refresh registry</strong>.
					</CardContent>
				</Card>
			) : null}
			{noProjects ? (
				<Card>
					<CardContent className="p-4 text-sm text-(--color-destructive)">
						No projects added. Visit <strong>Projects</strong> to clone one from
						GitHub.
					</CardContent>
				</Card>
			) : null}

			<Card>
				<CardHeader>
					<CardTitle>Run configuration</CardTitle>
				</CardHeader>
				<CardContent>
					<form onSubmit={handleSubmit} className="space-y-4">
						<div className="space-y-1.5">
							<Label htmlFor="agent">Agent</Label>
							<select
								id="agent"
								required
								value={agent}
								onChange={(e) => setAgent(e.target.value)}
								className="flex h-9 w-full rounded-md border bg-(--color-card) px-3 py-1 text-sm shadow-xs focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-(--color-ring)"
							>
								<option value="" disabled>
									Pick an agent…
								</option>
								{agents.data?.agents.map((a) => (
									<option key={a.name} value={a.name}>
										{a.name}
									</option>
								))}
							</select>
						</div>

						<div className="space-y-1.5">
							<Label htmlFor="project">Project</Label>
							<select
								id="project"
								required
								value={project}
								onChange={(e) => setProject(e.target.value)}
								className="flex h-9 w-full rounded-md border bg-(--color-card) px-3 py-1 text-sm shadow-xs focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-(--color-ring)"
							>
								<option value="" disabled>
									Pick a project…
								</option>
								{projects.data?.projects.map((p) => (
									<option key={p.id} value={p.id}>
										{p.gitUrl} ({p.id})
									</option>
								))}
							</select>
						</div>

						<div className="space-y-1.5">
							<Label htmlFor="prompt">Prompt</Label>
							<Textarea
								id="prompt"
								required
								rows={6}
								value={prompt}
								onChange={(e) => setPrompt(e.target.value)}
								placeholder="What should the agent do?"
							/>
						</div>

						{spawn.isError ? (
							<p className="text-sm text-(--color-destructive)">
								{spawn.error instanceof Error
									? spawn.error.message
									: String(spawn.error)}
							</p>
						) : null}

						<div className="flex justify-end gap-2">
							<Button
								type="button"
								variant="outline"
								onClick={() => navigate("/runs")}
								disabled={spawn.isPending}
							>
								Cancel
							</Button>
							<Button
								type="submit"
								disabled={
									spawn.isPending ||
									agent.length === 0 ||
									project.length === 0 ||
									prompt.trim().length === 0
								}
							>
								{spawn.isPending ? "Dispatching…" : "Dispatch"}
							</Button>
						</div>
					</form>
				</CardContent>
			</Card>
		</div>
	);
}
