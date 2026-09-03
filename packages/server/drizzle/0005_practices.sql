CREATE TABLE `practices` (
	`path` text PRIMARY KEY NOT NULL,
	`slug` text NOT NULL,
	`status` text NOT NULL,
	`scope` text NOT NULL,
	`project_slug` text,
	`fact` text NOT NULL,
	`learned_from` text,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `idx_practices_slug` ON `practices` (`slug`);--> statement-breakpoint
CREATE INDEX `idx_practices_status` ON `practices` (`status`);
