CREATE TABLE `projects` (
	`id` text PRIMARY KEY NOT NULL,
	`slug` text NOT NULL,
	`name` text NOT NULL,
	`description` text NOT NULL,
	`resources_json` text NOT NULL,
	`policy_json` text NOT NULL,
	`model_prefs_json` text NOT NULL,
	`archived` integer DEFAULT false NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `projects_slug_unique` ON `projects` (`slug`);--> statement-breakpoint
CREATE INDEX `idx_projects_slug` ON `projects` (`slug`);--> statement-breakpoint
ALTER TABLE `tasks` ADD `project_id` text;