CREATE TABLE `ebay_cost_snapshot_state` (
	`id` integer PRIMARY KEY NOT NULL,
	`dirty` integer DEFAULT false NOT NULL,
	`pending_count` integer DEFAULT 0 NOT NULL,
	`dirty_at` text DEFAULT '' NOT NULL,
	`last_exported_at` text DEFAULT '' NOT NULL,
	`cost_master_file_id` text DEFAULT '' NOT NULL,
	`last_error` text DEFAULT '' NOT NULL
);
--> statement-breakpoint
CREATE TABLE `woh_cost_index` (
	`woh_key` text PRIMARY KEY NOT NULL,
	`woh_sku` text DEFAULT '' NOT NULL,
	`item_number` text DEFAULT '' NOT NULL,
	`description` text DEFAULT '' NOT NULL,
	`unit_cost_landed` text DEFAULT '0' NOT NULL,
	`source_version` text DEFAULT '' NOT NULL,
	`updated_at` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX `idx_woh_cost_index_sku` ON `woh_cost_index` (`woh_sku`);--> statement-breakpoint
CREATE INDEX `idx_woh_cost_index_item_number` ON `woh_cost_index` (`item_number`);--> statement-breakpoint
CREATE INDEX `idx_ebay_item_mapping_ebay_sku_lower` ON `ebay_item_mapping` (lower(`ebay_sku`));--> statement-breakpoint
PRAGMA optimize;
