CREATE TABLE `triggers` (
	`id` text PRIMARY KEY NOT NULL,
	`project_id` text NOT NULL,
	`trigger_id` text NOT NULL,
	`last_fired_at` text,
	`next_fire_at` text,
	`last_run_id` text,
	FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`last_run_id`) REFERENCES `runs`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE INDEX `triggers_project_idx` ON `triggers` (`project_id`);