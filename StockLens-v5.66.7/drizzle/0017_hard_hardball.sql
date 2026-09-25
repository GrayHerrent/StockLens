CREATE TABLE `amazon_replenishment_item_decision` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`report_id` text NOT NULL,
	`line_key` text NOT NULL,
	`decision_type` text NOT NULL,
	`value_json` text DEFAULT '{}' NOT NULL,
	`active` integer DEFAULT true NOT NULL,
	`source_user` text DEFAULT 'StockLens user' NOT NULL,
	`updated_at` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX `amazon_replenishment_item_decision_lookup_idx` ON `amazon_replenishment_item_decision` (`report_id`,`line_key`,`decision_type`);