CREATE TABLE `skills` (
	`path` text PRIMARY KEY NOT NULL,
	`slug` text NOT NULL,
	`status` text NOT NULL,
	`scope` text NOT NULL,
	`project_slug` text,
	`description` text NOT NULL,
	`learned_from` text,
	`uses` integer DEFAULT 0 NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `idx_skills_slug` ON `skills` (`slug`);--> statement-breakpoint
CREATE INDEX `idx_skills_status` ON `skills` (`status`);