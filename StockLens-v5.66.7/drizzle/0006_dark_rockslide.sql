CREATE TABLE `amazon_inventory_report_job` (
	`month_key` text NOT NULL,
	`marketplace_id` text NOT NULL,
	`start_date` text NOT NULL,
	`end_date` text NOT NULL,
	`report_id` text NOT NULL,
	`processing_status` text DEFAULT 'IN_QUEUE' NOT NULL,
	`rate_limit` text DEFAULT '' NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	PRIMARY KEY(`month_key`, `marketplace_id`)
);
