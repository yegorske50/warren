ALTER TABLE `runs` ADD `plot_id` text;--> statement-breakpoint
CREATE INDEX `runs_plot_id_idx` ON `runs` (`plot_id`);