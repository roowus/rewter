CREATE TABLE `approvals` (
	`id` text PRIMARY KEY NOT NULL,
	`task_id` text NOT NULL,
	`work_item_id` text,
	`worker_run_id` text,
	`status` text NOT NULL,
	`kind` text NOT NULL,
	`summary` text NOT NULL,
	`detail_json` text,
	`resolved_by` text,
	`resolution_note` text,
	`created_at` integer NOT NULL,
	`resolved_at` integer,
	FOREIGN KEY (`task_id`) REFERENCES `tasks`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `idx_approvals_task` ON `approvals` (`task_id`);--> statement-breakpoint
CREATE INDEX `idx_approvals_status` ON `approvals` (`status`);--> statement-breakpoint
CREATE TABLE `capability_cards` (
	`model_id` text PRIMARY KEY NOT NULL,
	`summary` text NOT NULL,
	`strengths_json` text NOT NULL,
	`weaknesses_json` text NOT NULL,
	`best_at_json` text NOT NULL,
	`notes` text,
	`user_overrides_json` text,
	`generated_by` text,
	`generated_at` integer,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`model_id`) REFERENCES `models`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `cost_records` (
	`id` text PRIMARY KEY NOT NULL,
	`task_id` text,
	`worker_run_id` text,
	`model_id` text NOT NULL,
	`input_tokens` integer NOT NULL,
	`output_tokens` integer NOT NULL,
	`cache_read_tokens` integer DEFAULT 0 NOT NULL,
	`cache_write_tokens` integer DEFAULT 0 NOT NULL,
	`cost_usd` real NOT NULL,
	`pricing_snapshot_json` text NOT NULL,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `idx_cost_records_task` ON `cost_records` (`task_id`);--> statement-breakpoint
CREATE TABLE `events` (
	`seq` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`ts` integer NOT NULL,
	`task_id` text,
	`type` text NOT NULL,
	`payload_json` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX `idx_events_task` ON `events` (`task_id`);--> statement-breakpoint
CREATE INDEX `idx_events_type` ON `events` (`type`);--> statement-breakpoint
CREATE TABLE `model_stats` (
	`model_id` text NOT NULL,
	`task_tag` text NOT NULL,
	`attempts` integer DEFAULT 0 NOT NULL,
	`successes` integer DEFAULT 0 NOT NULL,
	`avg_cost_usd` real,
	`avg_latency_ms` real,
	`updated_at` integer NOT NULL,
	PRIMARY KEY(`model_id`, `task_tag`)
);
--> statement-breakpoint
CREATE TABLE `models` (
	`id` text PRIMARY KEY NOT NULL,
	`provider_id` text NOT NULL,
	`upstream_id` text NOT NULL,
	`display_name` text NOT NULL,
	`context_window` integer,
	`max_output_tokens` integer,
	`pricing_json` text NOT NULL,
	`modalities_json` text NOT NULL,
	`supports_json` text NOT NULL,
	`source` text NOT NULL,
	`enabled` integer DEFAULT true NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`provider_id`) REFERENCES `providers`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `providers` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`kind` text NOT NULL,
	`base_url` text,
	`api_key_ref` text,
	`enabled` integer DEFAULT true NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `tasks` (
	`id` text PRIMARY KEY NOT NULL,
	`status` text NOT NULL,
	`title` text NOT NULL,
	`initiator_model_id` text NOT NULL,
	`conversation_fingerprint` text,
	`settings_json` text NOT NULL,
	`result_summary` text,
	`error` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	`finished_at` integer
);
--> statement-breakpoint
CREATE INDEX `idx_tasks_status` ON `tasks` (`status`);--> statement-breakpoint
CREATE INDEX `idx_tasks_fingerprint` ON `tasks` (`conversation_fingerprint`);--> statement-breakpoint
CREATE TABLE `work_items` (
	`id` text PRIMARY KEY NOT NULL,
	`task_id` text NOT NULL,
	`parent_work_item_id` text,
	`status` text NOT NULL,
	`title` text NOT NULL,
	`instructions` text NOT NULL,
	`model_id` text NOT NULL,
	`tier` integer NOT NULL,
	`result_summary` text,
	`error` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	`finished_at` integer,
	FOREIGN KEY (`task_id`) REFERENCES `tasks`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `idx_work_items_task` ON `work_items` (`task_id`);--> statement-breakpoint
CREATE TABLE `worker_runs` (
	`id` text PRIMARY KEY NOT NULL,
	`work_item_id` text NOT NULL,
	`task_id` text NOT NULL,
	`status` text NOT NULL,
	`model_id` text NOT NULL,
	`tier` integer NOT NULL,
	`attempt` integer NOT NULL,
	`harness_session_id` text,
	`result_text` text,
	`error` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	`finished_at` integer,
	FOREIGN KEY (`work_item_id`) REFERENCES `work_items`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`task_id`) REFERENCES `tasks`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `idx_worker_runs_work_item` ON `worker_runs` (`work_item_id`);--> statement-breakpoint
CREATE INDEX `idx_worker_runs_task` ON `worker_runs` (`task_id`);