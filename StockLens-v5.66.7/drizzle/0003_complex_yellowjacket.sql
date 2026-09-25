ALTER TABLE `ebay_item_mapping` ADD `workflow_status` text DEFAULT 'Unmatched' NOT NULL;
--> statement-breakpoint
UPDATE `ebay_item_mapping`
SET `workflow_status` = CASE
  WHEN `assembly` = 1 THEN 'Assemblies'
  WHEN `deferred` = 1 THEN 'Deferred'
  WHEN TRIM(`woh_sku`) <> '' THEN 'Manually Matched'
  ELSE 'Unmatched'
END;
