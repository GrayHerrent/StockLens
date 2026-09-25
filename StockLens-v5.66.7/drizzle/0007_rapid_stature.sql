CREATE TABLE `amazon_inventory_report_cache` (
	`report_id` text PRIMARY KEY NOT NULL,
	`month_key` text NOT NULL,
	`marketplace_id` text NOT NULL,
	`rows_json` text NOT NULL,
	`raw_row_count` integer DEFAULT 0 NOT NULL,
	`sellable_row_count` integer DEFAULT 0 NOT NULL,
	`sellable_units` integer DEFAULT 0 NOT NULL,
	`parser_version` integer DEFAULT 2 NOT NULL,
	`retrieved_at` text NOT NULL
);
