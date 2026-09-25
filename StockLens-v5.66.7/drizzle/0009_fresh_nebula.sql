CREATE TABLE `ebay_inventory_sync_run` (
	`run_date` text PRIMARY KEY NOT NULL,
	`status` text NOT NULL,
	`started_at` text NOT NULL,
	`completed_at` text,
	`snapshot_updated_at` text DEFAULT '' NOT NULL,
	`rows_json` text DEFAULT '[]' NOT NULL,
	`listing_count` integer DEFAULT 0 NOT NULL,
	`change_count` integer DEFAULT 0 NOT NULL,
	`review_count` integer DEFAULT 0 NOT NULL,
	`error` text DEFAULT '' NOT NULL,
	`approved_at` text
);
--> statement-breakpoint
CREATE TABLE `ebay_inventory_sync_snapshot` (
	`id` integer PRIMARY KEY NOT NULL,
	`rows_json` text NOT NULL,
	`source_updated_at` text NOT NULL
);
