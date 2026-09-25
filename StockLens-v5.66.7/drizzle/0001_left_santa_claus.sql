CREATE TABLE `ebay_mapping_change` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`session_id` text NOT NULL,
	`listing_key` text NOT NULL,
	`action` text NOT NULL,
	`old_value` text DEFAULT '' NOT NULL,
	`new_value` text DEFAULT '' NOT NULL,
	`changed_at` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `ebay_mapping_session` (
	`id` text PRIMARY KEY NOT NULL,
	`status` text NOT NULL,
	`started_at` text NOT NULL,
	`ended_at` text
);
--> statement-breakpoint
ALTER TABLE `ebay_item_mapping` ADD `deferred` integer DEFAULT false NOT NULL;