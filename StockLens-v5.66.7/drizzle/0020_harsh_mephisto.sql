CREATE TABLE `ebay_inventory_listing_fetch` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`fetched_at` text NOT NULL,
	`source` text DEFAULT 'Manual inventory sync' NOT NULL,
	`listing_count` integer DEFAULT 0 NOT NULL,
	`rows_json` text DEFAULT '[]' NOT NULL
);
--> statement-breakpoint
CREATE INDEX `ebay_inventory_listing_fetch_fetched_at_idx` ON `ebay_inventory_listing_fetch` (`fetched_at`);