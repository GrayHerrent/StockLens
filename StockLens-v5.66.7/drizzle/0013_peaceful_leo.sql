CREATE TABLE `ebay_inventory_quantity_override` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`listing_id` text NOT NULL,
	`ebay_sku` text DEFAULT '' NOT NULL,
	`title` text DEFAULT '' NOT NULL,
	`forced_quantity` integer DEFAULT 0 NOT NULL,
	`active` integer DEFAULT true NOT NULL,
	`reason` text DEFAULT '' NOT NULL,
	`updated_at` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX `ebay_inventory_quantity_override_updated_at_idx` ON `ebay_inventory_quantity_override` (`updated_at`);