CREATE TABLE `amazon_inbound_history_cache` (
	`marketplace_id` text PRIMARY KEY NOT NULL,
	`start_date` text NOT NULL,
	`end_date` text NOT NULL,
	`rows_json` text NOT NULL,
	`plan_count` integer DEFAULT 0 NOT NULL,
	`shipment_count` integer DEFAULT 0 NOT NULL,
	`retrieved_at` text NOT NULL
);
