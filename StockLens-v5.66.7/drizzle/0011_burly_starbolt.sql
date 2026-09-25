CREATE TABLE `shopify_item_mapping` (
	`variant_id` text PRIMARY KEY NOT NULL,
	`product_id` text NOT NULL,
	`shopify_sku` text DEFAULT '' NOT NULL,
	`woh_sku` text DEFAULT '' NOT NULL,
	`workflow_status` text DEFAULT 'Unmatched' NOT NULL,
	`confirmed` integer DEFAULT false NOT NULL,
	`assembly_components` text DEFAULT '[]' NOT NULL,
	`knowledge_source` text DEFAULT '' NOT NULL,
	`updated_at` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `shopify_variant_snapshot` (
	`variant_id` text PRIMARY KEY NOT NULL,
	`product_id` text NOT NULL,
	`sku` text DEFAULT '' NOT NULL,
	`title` text DEFAULT '' NOT NULL,
	`product_title` text DEFAULT '' NOT NULL,
	`product_status` text DEFAULT '' NOT NULL,
	`barcode` text DEFAULT '' NOT NULL,
	`imported_at` text NOT NULL
);
