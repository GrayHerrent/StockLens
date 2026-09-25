ALTER TABLE `ebay_item_mapping` ADD `knowledge_source` text DEFAULT '' NOT NULL;--> statement-breakpoint
ALTER TABLE `ebay_item_mapping` ADD `decision_locked` integer DEFAULT false NOT NULL;