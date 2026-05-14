CREATE TABLE `workers` (
	`name` text PRIMARY KEY NOT NULL,
	`url` text NOT NULL,
	`state` text DEFAULT 'healthy' NOT NULL,
	`added_at` text NOT NULL
);
