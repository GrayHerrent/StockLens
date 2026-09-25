CREATE TABLE `ebay_inventory_review_snapshot` (
	`review_id` text PRIMARY KEY NOT NULL,
	`run_date` text DEFAULT '' NOT NULL,
	`approved_at` text NOT NULL,
	`committed_at` text NOT NULL,
	`fingerprint` text NOT NULL,
	`row_count` integer DEFAULT 0 NOT NULL,
	`rows_json` text DEFAULT '[]' NOT NULL
);
--> statement-breakpoint
ALTER TABLE `ebay_inventory_upload_result` ADD `review_id` text DEFAULT '' NOT NULL;