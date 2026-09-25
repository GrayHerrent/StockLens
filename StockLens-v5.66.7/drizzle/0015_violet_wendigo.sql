CREATE TABLE `google_drive_connection` (
	`id` integer PRIMARY KEY NOT NULL,
	`credentials_ciphertext` text NOT NULL,
	`credentials_iv` text NOT NULL,
	`account_email` text DEFAULT '' NOT NULL,
	`connected_at` text NOT NULL,
	`updated_at` text NOT NULL,
	`last_tested_at` text NOT NULL
);
