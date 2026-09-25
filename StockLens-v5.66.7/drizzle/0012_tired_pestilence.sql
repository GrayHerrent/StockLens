CREATE TABLE `ebay_inventory_upload_result` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`run_date` text DEFAULT '' NOT NULL,
	`file_name` text NOT NULL,
	`uploaded_at` text NOT NULL,
	`total_rows` integer DEFAULT 0 NOT NULL,
	`succeeded_rows` integer DEFAULT 0 NOT NULL,
	`failed_rows` integer DEFAULT 0 NOT NULL,
	`unreported_rows` integer DEFAULT 0 NOT NULL,
	`rows_json` text DEFAULT '[]' NOT NULL
);
