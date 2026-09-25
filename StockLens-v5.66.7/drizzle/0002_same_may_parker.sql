CREATE TABLE `ebay_listing_snapshot` (
	`listing_key` text PRIMARY KEY NOT NULL,
	`listing_id` text NOT NULL,
	`title` text DEFAULT '' NOT NULL,
	`listing_sku` text DEFAULT '' NOT NULL,
	`sku` text DEFAULT '' NOT NULL,
	`variation` text DEFAULT '' NOT NULL,
	`price` text DEFAULT '0' NOT NULL,
	`currency` text DEFAULT 'USD' NOT NULL,
	`quantity_available` integer DEFAULT 0 NOT NULL,
	`quantity_sold` integer DEFAULT 0 NOT NULL,
	`listing_type` text DEFAULT '' NOT NULL,
	`status` text DEFAULT 'Active' NOT NULL,
	`imported_at` text NOT NULL
);
