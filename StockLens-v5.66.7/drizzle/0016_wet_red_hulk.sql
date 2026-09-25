CREATE TABLE `amazon_replacement_decision` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`target_woh_sku` text NOT NULL,
	`source_woh_sku` text NOT NULL,
	`source_units_per_target` integer DEFAULT 1 NOT NULL,
	`active` integer DEFAULT true NOT NULL,
	`source_user` text DEFAULT 'StockLens user' NOT NULL,
	`updated_at` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX `amazon_replacement_target_idx` ON `amazon_replacement_decision` (`target_woh_sku`);--> statement-breakpoint
CREATE TABLE `amazon_replenishment_report_cache` (
	`report_id` text PRIMARY KEY NOT NULL,
	`marketplace_id` text NOT NULL,
	`rows_json` text NOT NULL,
	`row_count` integer DEFAULT 0 NOT NULL,
	`retrieved_at` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `amazon_replenishment_report_job` (
	`marketplace_id` text PRIMARY KEY NOT NULL,
	`report_id` text NOT NULL,
	`processing_status` text DEFAULT 'IN_QUEUE' NOT NULL,
	`rate_limit` text DEFAULT '' NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `amazon_replenishment_run` (
	`id` text PRIMARY KEY NOT NULL,
	`marketplace_id` text NOT NULL,
	`report_id` text NOT NULL,
	`amazon_retrieved_at` text NOT NULL,
	`master_versions_json` text DEFAULT '{}' NOT NULL,
	`settings_json` text DEFAULT '{}' NOT NULL,
	`plan_json` text DEFAULT '[]' NOT NULL,
	`verification_json` text DEFAULT '{}' NOT NULL,
	`finalized` integer DEFAULT false NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL
);
