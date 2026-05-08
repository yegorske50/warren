CREATE TABLE `agents` (
	`name` text PRIMARY KEY NOT NULL,
	`rendered_json` text NOT NULL,
	`registered_at` text NOT NULL,
	`last_refreshed` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `events` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`run_id` text NOT NULL,
	`burrow_event_seq` integer NOT NULL,
	`ts` text NOT NULL,
	`kind` text NOT NULL,
	`stream` text,
	`payload_json` text NOT NULL,
	FOREIGN KEY (`run_id`) REFERENCES `runs`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `events_run_seq_idx` ON `events` (`run_id`,`burrow_event_seq`);--> statement-breakpoint
CREATE INDEX `events_run_ts_idx` ON `events` (`run_id`,`ts`);--> statement-breakpoint
CREATE TABLE `projects` (
	`id` text PRIMARY KEY NOT NULL,
	`git_url` text NOT NULL,
	`local_path` text NOT NULL,
	`default_branch` text NOT NULL,
	`added_at` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX `projects_git_url_idx` ON `projects` (`git_url`);--> statement-breakpoint
CREATE TABLE `runs` (
	`id` text PRIMARY KEY NOT NULL,
	`agent_name` text NOT NULL,
	`project_id` text NOT NULL,
	`burrow_id` text,
	`burrow_run_id` text,
	`rendered_agent_json` text NOT NULL,
	`state` text NOT NULL,
	`started_at` text,
	`ended_at` text,
	`prompt` text NOT NULL,
	`trigger` text NOT NULL,
	FOREIGN KEY (`agent_name`) REFERENCES `agents`(`name`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `runs_state_idx` ON `runs` (`state`);--> statement-breakpoint
CREATE INDEX `runs_project_started_idx` ON `runs` (`project_id`,"started_at" DESC);--> statement-breakpoint
CREATE INDEX `runs_agent_started_idx` ON `runs` (`agent_name`,"started_at" DESC);