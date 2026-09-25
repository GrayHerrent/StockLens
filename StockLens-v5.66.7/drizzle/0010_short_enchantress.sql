CREATE TABLE `shopify_connection` (
	`id` integer PRIMARY KEY NOT NULL,
	`shop_domain` text NOT NULL,
	`shop_name` text DEFAULT '' NOT NULL,
	`credentials_ciphertext` text NOT NULL,
	`credentials_iv` text NOT NULL,
	`scopes_json` text DEFAULT '[]' NOT NULL,
	`connected_at` text NOT NULL,
	`updated_at` text NOT NULL,
	`last_tested_at` text NOT NULL
);
