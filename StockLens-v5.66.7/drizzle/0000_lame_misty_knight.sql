CREATE TABLE `ebay_item_mapping` (
	`listing_key` text PRIMARY KEY NOT NULL,
	`listing_id` text NOT NULL,
	`ebay_sku` text DEFAULT '' NOT NULL,
	`woh_sku` text DEFAULT '' NOT NULL,
	`assembly` integer DEFAULT false NOT NULL,
	`updated_at` text NOT NULL
);
