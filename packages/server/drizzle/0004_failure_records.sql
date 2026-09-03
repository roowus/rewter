CREATE TABLE `failure_records` (
	`id` text PRIMARY KEY NOT NULL,
	`task_id` text,
	`worker_run_id` text,
	`model_id` text NOT NULL,
	`provider_id` text NOT NULL,
	`attempt` integer NOT NULL,
	`phase` text NOT NULL,
	`retried` integer NOT NULL,
	`retryable` integer NOT NULL,
	`status_code` integer,
	`message` text NOT NULL,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `idx_failure_records_created` ON `failure_records` (`created_at`);--> statement-breakpoint
CREATE INDEX `idx_failure_records_model` ON `failure_records` (`model_id`);