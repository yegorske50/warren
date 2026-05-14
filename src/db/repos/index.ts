/**
 * Convenience surface that wires every repo against a single drizzle handle.
 * Higher layers grab one Repos and pass it through.
 */

import type { WarrenDb } from "../client.ts";
import { AgentsRepo } from "./agents.ts";
import { EventsRepo } from "./events.ts";
import { ProjectsRepo } from "./projects.ts";
import { RunsRepo } from "./runs.ts";
import { TriggersRepo } from "./triggers.ts";
import { WorkersRepo } from "./workers.ts";

export interface Repos {
	agents: AgentsRepo;
	projects: ProjectsRepo;
	runs: RunsRepo;
	events: EventsRepo;
	triggers: TriggersRepo;
	workers: WorkersRepo;
}

export function createRepos(db: WarrenDb): Repos {
	return {
		agents: new AgentsRepo(db.drizzle),
		projects: new ProjectsRepo(db.drizzle),
		runs: new RunsRepo(db.drizzle),
		events: new EventsRepo(db.drizzle),
		triggers: new TriggersRepo(db.drizzle),
		workers: new WorkersRepo(db.drizzle),
	};
}

export { AgentsRepo, EventsRepo, ProjectsRepo, RunsRepo, TriggersRepo, WorkersRepo };
