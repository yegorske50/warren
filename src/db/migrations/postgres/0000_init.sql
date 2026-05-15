CREATE TABLE "agents" (
	"name" text PRIMARY KEY NOT NULL,
	"rendered_json" jsonb NOT NULL,
	"registered_at" text NOT NULL,
	"last_refreshed" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "burrows" (
	"id" text PRIMARY KEY NOT NULL,
	"worker_id" text NOT NULL,
	"added_at" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "events" (
	"id" serial PRIMARY KEY NOT NULL,
	"run_id" text NOT NULL,
	"burrow_event_seq" integer NOT NULL,
	"ts" text NOT NULL,
	"kind" text NOT NULL,
	"stream" text,
	"payload_json" jsonb NOT NULL
);
--> statement-breakpoint
CREATE TABLE "projects" (
	"id" text PRIMARY KEY NOT NULL,
	"git_url" text NOT NULL,
	"local_path" text NOT NULL,
	"default_branch" text NOT NULL,
	"added_at" text NOT NULL,
	"last_fetched_at" text,
	"last_head_sha" text
);
--> statement-breakpoint
CREATE TABLE "runs" (
	"id" text PRIMARY KEY NOT NULL,
	"agent_name" text NOT NULL,
	"project_id" text,
	"burrow_id" text,
	"burrow_run_id" text,
	"worker_id" text,
	"rendered_agent_json" jsonb NOT NULL,
	"state" text NOT NULL,
	"failure_reason" text,
	"started_at" text,
	"ended_at" text,
	"prompt" text NOT NULL,
	"trigger" text NOT NULL,
	"pr_url" text,
	"cost_usd" double precision,
	"tokens_input" integer,
	"tokens_output" integer,
	"tokens_cache_read" integer,
	"tokens_cache_write" integer
);
--> statement-breakpoint
CREATE TABLE "triggers" (
	"id" text PRIMARY KEY NOT NULL,
	"project_id" text NOT NULL,
	"trigger_id" text NOT NULL,
	"last_fired_at" text,
	"next_fire_at" text,
	"last_run_id" text
);
--> statement-breakpoint
CREATE TABLE "workers" (
	"name" text PRIMARY KEY NOT NULL,
	"url" text NOT NULL,
	"state" text DEFAULT 'healthy' NOT NULL,
	"added_at" text NOT NULL
);
--> statement-breakpoint
ALTER TABLE "events" ADD CONSTRAINT "events_run_id_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "runs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "runs" ADD CONSTRAINT "runs_agent_name_agents_name_fk" FOREIGN KEY ("agent_name") REFERENCES "agents"("name") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "runs" ADD CONSTRAINT "runs_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "projects"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "triggers" ADD CONSTRAINT "triggers_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "triggers" ADD CONSTRAINT "triggers_last_run_id_runs_id_fk" FOREIGN KEY ("last_run_id") REFERENCES "runs"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "burrows_worker_idx" ON "burrows" USING btree ("worker_id");--> statement-breakpoint
CREATE INDEX "events_run_seq_idx" ON "events" USING btree ("run_id","burrow_event_seq");--> statement-breakpoint
CREATE INDEX "events_run_ts_idx" ON "events" USING btree ("run_id","ts");--> statement-breakpoint
CREATE INDEX "projects_git_url_idx" ON "projects" USING btree ("git_url");--> statement-breakpoint
CREATE INDEX "runs_state_idx" ON "runs" USING btree ("state");--> statement-breakpoint
CREATE INDEX "runs_project_started_idx" ON "runs" USING btree ("project_id","started_at" DESC);--> statement-breakpoint
CREATE INDEX "runs_agent_started_idx" ON "runs" USING btree ("agent_name","started_at" DESC);--> statement-breakpoint
CREATE INDEX "runs_worker_state_idx" ON "runs" USING btree ("worker_id","state");--> statement-breakpoint
CREATE INDEX "triggers_project_idx" ON "triggers" USING btree ("project_id");