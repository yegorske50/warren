/**
 * Repository for the `projects` table.
 *
 * Projects are GitHub repos cloned under /data/projects/<owner>/<name> (SPEC
 * §5). The repo only owns the row; cloning, default-branch detection, and
 * filesystem layout are Phase 4's domain.
 */

import { asc, eq } from "drizzle-orm";
import { NotFoundError } from "../../core/errors.ts";
import { generateId } from "../../core/ids.ts";
import type { DrizzleDb } from "../client.ts";
import { type ProjectRow, projects } from "../schema.ts";

export interface CreateProjectInput {
	id?: string;
	gitUrl: string;
	localPath: string;
	defaultBranch: string;
	now?: Date;
}

export interface RecordRefreshInput {
	id: string;
	headSha: string;
	now?: Date;
}

export class ProjectsRepo {
	constructor(private readonly db: DrizzleDb) {}

	async create(input: CreateProjectInput): Promise<ProjectRow> {
		const row: ProjectRow = {
			id: input.id ?? generateId("project"),
			gitUrl: input.gitUrl,
			localPath: input.localPath,
			defaultBranch: input.defaultBranch,
			addedAt: (input.now ?? new Date()).toISOString(),
			lastFetchedAt: null,
			lastHeadSha: null,
		};
		this.db.insert(projects).values(row).run();
		return row;
	}

	async recordRefresh(input: RecordRefreshInput): Promise<ProjectRow> {
		const lastFetchedAt = (input.now ?? new Date()).toISOString();
		this.db
			.update(projects)
			.set({ lastFetchedAt, lastHeadSha: input.headSha })
			.where(eq(projects.id, input.id))
			.run();
		return this.require(input.id);
	}

	async get(id: string): Promise<ProjectRow | null> {
		return this.db.select().from(projects).where(eq(projects.id, id)).get() ?? null;
	}

	async require(id: string): Promise<ProjectRow> {
		const row = await this.get(id);
		if (!row) {
			throw new NotFoundError(`project not found: ${id}`, {
				recoveryHint: "GET /projects to list known ids",
			});
		}
		return row;
	}

	async findByGitUrl(gitUrl: string): Promise<ProjectRow | null> {
		return this.db.select().from(projects).where(eq(projects.gitUrl, gitUrl)).get() ?? null;
	}

	async listAll(): Promise<ProjectRow[]> {
		return this.db.select().from(projects).orderBy(asc(projects.addedAt)).all();
	}

	async delete(id: string): Promise<void> {
		this.db.delete(projects).where(eq(projects.id, id)).run();
	}
}
