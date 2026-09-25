import { index, integer, primaryKey, sqliteTable, text } from "drizzle-orm/sqlite-core";

export const ebayItemMappings = sqliteTable("ebay_item_mapping", {
  listingKey: text("listing_key").primaryKey(),
  listingId: text("listing_id").notNull(),
  ebaySku: text("ebay_sku").notNull().default(""),
  wohSku: text("woh_sku").notNull().default(""),
  assembly: integer("assembly", { mode: "boolean" }).notNull().default(false),
  deferred: integer("deferred", { mode: "boolean" }).notNull().default(false),
  workflowStatus: text("workflow_status").notNull().default("Unmatched"),
  assemblyComponents: text("assembly_components").notNull().default("[]"),
  knowledgeSource: text("knowledge_source").notNull().default(""),
  decisionLocked: integer("decision_locked", { mode: "boolean" }).notNull().default(false),
  updatedAt: text("updated_at").notNull(),
});

export const ebayMappingSessions = sqliteTable("ebay_mapping_session", {
  id: text("id").primaryKey(),
  status: text("status").notNull(),
  startedAt: text("started_at").notNull(),
  endedAt: text("ended_at"),
});

export const ebayMappingChanges = sqliteTable("ebay_mapping_change", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  sessionId: text("session_id").notNull(),
  listingKey: text("listing_key").notNull(),
  action: text("action").notNull(),
  oldValue: text("old_value").notNull().default(""),
  newValue: text("new_value").notNull().default(""),
  changedAt: text("changed_at").notNull(),
});

export const wohCostIndex = sqliteTable("woh_cost_index", {
  wohKey: text("woh_key").primaryKey(),
  wohSku: text("woh_sku").notNull().default(""),
  itemNumber: text("item_number").notNull().default(""),
  description: text("description").notNull().default(""),
  unitCostLanded: text("unit_cost_landed").notNull().default("0"),
  sourceVersion: text("source_version").notNull().default(""),
  updatedAt: text("updated_at").notNull(),
}, (table) => [
  index("idx_woh_cost_index_sku").on(table.wohSku),
  index("idx_woh_cost_index_item_number").on(table.itemNumber),
]);

export const ebayCostSnapshotState = sqliteTable("ebay_cost_snapshot_state", {
  id: integer("id").primaryKey(),
  dirty: integer("dirty", { mode: "boolean" }).notNull().default(false),
  pendingCount: integer("pending_count").notNull().default(0),
  dirtyAt: text("dirty_at").notNull().default(""),
  lastExportedAt: text("last_exported_at").notNull().default(""),
  costMasterFileId: text("cost_master_file_id").notNull().default(""),
  lastError: text("last_error").notNull().default(""),
});

export const ebayListingSnapshot = sqliteTable("ebay_listing_snapshot", {
  listingKey: text("listing_key").primaryKey(),
  listingId: text("listing_id").notNull(),
  title: text("title").notNull().default(""),
  listingSku: text("listing_sku").notNull().default(""),
  sku: text("sku").notNull().default(""),
  variation: text("variation").notNull().default(""),
  price: text("price").notNull().default("0"),
  currency: text("currency").notNull().default("USD"),
  quantityAvailable: integer("quantity_available").notNull().default(0),
  quantitySold: integer("quantity_sold").notNull().default(0),
  listingType: text("listing_type").notNull().default(""),
  status: text("status").notNull().default("Active"),
  importedAt: text("imported_at").notNull(),
});

export const amazonConnection = sqliteTable("amazon_connection", {
  id: integer("id").primaryKey(),
  credentialsCiphertext: text("credentials_ciphertext").notNull(),
  credentialsIv: text("credentials_iv").notNull(),
  region: text("region").notNull().default("na"),
  marketplacesJson: text("marketplaces_json").notNull().default("[]"),
  connectedAt: text("connected_at").notNull(),
  updatedAt: text("updated_at").notNull(),
  lastTestedAt: text("last_tested_at").notNull(),
});

export const amazonInventoryReportJobs = sqliteTable("amazon_inventory_report_job", {
  monthKey: text("month_key").notNull(),
  marketplaceId: text("marketplace_id").notNull(),
  startDate: text("start_date").notNull(),
  endDate: text("end_date").notNull(),
  reportId: text("report_id").notNull(),
  processingStatus: text("processing_status").notNull().default("IN_QUEUE"),
  rateLimit: text("rate_limit").notNull().default(""),
  createdAt: text("created_at").notNull(),
  updatedAt: text("updated_at").notNull(),
}, (table) => [primaryKey({ columns: [table.monthKey, table.marketplaceId] })]);

export const amazonInventoryReportCache = sqliteTable("amazon_inventory_report_cache", {
  reportId: text("report_id").primaryKey(),
  monthKey: text("month_key").notNull(),
  marketplaceId: text("marketplace_id").notNull(),
  rowsJson: text("rows_json").notNull(),
  rawRowCount: integer("raw_row_count").notNull().default(0),
  sellableRowCount: integer("sellable_row_count").notNull().default(0),
  sellableUnits: integer("sellable_units").notNull().default(0),
  parserVersion: integer("parser_version").notNull().default(2),
  retrievedAt: text("retrieved_at").notNull(),
});

export const amazonInboundHistoryCache = sqliteTable("amazon_inbound_history_cache", {
  marketplaceId: text("marketplace_id").primaryKey(),
  startDate: text("start_date").notNull(),
  endDate: text("end_date").notNull(),
  rowsJson: text("rows_json").notNull(),
  planCount: integer("plan_count").notNull().default(0),
  shipmentCount: integer("shipment_count").notNull().default(0),
  retrievedAt: text("retrieved_at").notNull(),
});

export const amazonReplenishmentReportJobs = sqliteTable("amazon_replenishment_report_job", {
  marketplaceId: text("marketplace_id").primaryKey(),
  reportId: text("report_id").notNull(),
  processingStatus: text("processing_status").notNull().default("IN_QUEUE"),
  rateLimit: text("rate_limit").notNull().default(""),
  createdAt: text("created_at").notNull(),
  updatedAt: text("updated_at").notNull(),
});

export const amazonReplenishmentReportCache = sqliteTable("amazon_replenishment_report_cache", {
  reportId: text("report_id").primaryKey(),
  marketplaceId: text("marketplace_id").notNull(),
  rowsJson: text("rows_json").notNull(),
  rowCount: integer("row_count").notNull().default(0),
  retrievedAt: text("retrieved_at").notNull(),
}, (table) => [index("amazon_replenishment_cache_marketplace_retrieved_idx").on(table.marketplaceId, table.retrievedAt)]);

export const amazonReplenishmentRuns = sqliteTable("amazon_replenishment_run", {
  id: text("id").primaryKey(),
  marketplaceId: text("marketplace_id").notNull(),
  reportId: text("report_id").notNull(),
  amazonRetrievedAt: text("amazon_retrieved_at").notNull(),
  masterVersionsJson: text("master_versions_json").notNull().default("{}"),
  settingsJson: text("settings_json").notNull().default("{}"),
  planJson: text("plan_json").notNull().default("[]"),
  verificationJson: text("verification_json").notNull().default("{}"),
  finalized: integer("finalized", { mode: "boolean" }).notNull().default(false),
  createdAt: text("created_at").notNull(),
  updatedAt: text("updated_at").notNull(),
});

export const amazonReplacementDecisions = sqliteTable("amazon_replacement_decision", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  targetWohSku: text("target_woh_sku").notNull(),
  sourceWohSku: text("source_woh_sku").notNull(),
  sourceUnitsPerTarget: integer("source_units_per_target").notNull().default(1),
  active: integer("active", { mode: "boolean" }).notNull().default(true),
  sourceUser: text("source_user").notNull().default("StockLens user"),
  updatedAt: text("updated_at").notNull(),
}, (table) => [index("amazon_replacement_target_idx").on(table.targetWohSku)]);

export const amazonReplenishmentItemDecisions = sqliteTable("amazon_replenishment_item_decision", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  reportId: text("report_id").notNull(),
  lineKey: text("line_key").notNull(),
  decisionType: text("decision_type").notNull(),
  valueJson: text("value_json").notNull().default("{}"),
  active: integer("active", { mode: "boolean" }).notNull().default(true),
  sourceUser: text("source_user").notNull().default("StockLens user"),
  updatedAt: text("updated_at").notNull(),
}, (table) => [index("amazon_replenishment_item_decision_lookup_idx").on(table.reportId, table.lineKey, table.decisionType)]);

export const ebayInventorySyncSnapshot = sqliteTable("ebay_inventory_sync_snapshot", {
  id: integer("id").primaryKey(),
  rowsJson: text("rows_json").notNull(),
  sourceUpdatedAt: text("source_updated_at").notNull(),
});

export const ebayInventoryListingFetches = sqliteTable("ebay_inventory_listing_fetch", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  fetchedAt: text("fetched_at").notNull(),
  source: text("source").notNull().default("Manual inventory sync"),
  listingCount: integer("listing_count").notNull().default(0),
  rowsJson: text("rows_json").notNull().default("[]"),
}, (table) => [index("ebay_inventory_listing_fetch_fetched_at_idx").on(table.fetchedAt)]);

export const googleDriveConnection = sqliteTable("google_drive_connection", {
  id: integer("id").primaryKey(),
  credentialsCiphertext: text("credentials_ciphertext").notNull(),
  credentialsIv: text("credentials_iv").notNull(),
  accountEmail: text("account_email").notNull().default(""),
  connectedAt: text("connected_at").notNull(),
  updatedAt: text("updated_at").notNull(),
  lastTestedAt: text("last_tested_at").notNull(),
});

export const ebayInventorySyncRuns = sqliteTable("ebay_inventory_sync_run", {
  runDate: text("run_date").primaryKey(),
  status: text("status").notNull(),
  startedAt: text("started_at").notNull(),
  completedAt: text("completed_at"),
  snapshotUpdatedAt: text("snapshot_updated_at").notNull().default(""),
  rowsJson: text("rows_json").notNull().default("[]"),
  listingCount: integer("listing_count").notNull().default(0),
  changeCount: integer("change_count").notNull().default(0),
  reviewCount: integer("review_count").notNull().default(0),
  error: text("error").notNull().default(""),
  approvedAt: text("approved_at"),
});

export const ebayInventoryReviewSnapshots = sqliteTable("ebay_inventory_review_snapshot", {
  reviewId: text("review_id").primaryKey(),
  runDate: text("run_date").notNull().default(""),
  approvedAt: text("approved_at").notNull(),
  committedAt: text("committed_at").notNull(),
  fingerprint: text("fingerprint").notNull(),
  rowCount: integer("row_count").notNull().default(0),
  rowsJson: text("rows_json").notNull().default("[]"),
});

export const ebayInventoryUploadResults = sqliteTable("ebay_inventory_upload_result", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  reviewId: text("review_id").notNull().default(""),
  runDate: text("run_date").notNull().default(""),
  fileName: text("file_name").notNull(),
  uploadedAt: text("uploaded_at").notNull(),
  totalRows: integer("total_rows").notNull().default(0),
  succeededRows: integer("succeeded_rows").notNull().default(0),
  failedRows: integer("failed_rows").notNull().default(0),
  unreportedRows: integer("unreported_rows").notNull().default(0),
  rowsJson: text("rows_json").notNull().default("[]"),
});

export const ebayInventoryQuantityOverrides = sqliteTable("ebay_inventory_quantity_override", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  listingId: text("listing_id").notNull(),
  ebaySku: text("ebay_sku").notNull().default(""),
  title: text("title").notNull().default(""),
  forcedQuantity: integer("forced_quantity").notNull().default(0),
  active: integer("active", { mode: "boolean" }).notNull().default(true),
  reason: text("reason").notNull().default(""),
  updatedAt: text("updated_at").notNull(),
}, (table) => [index("ebay_inventory_quantity_override_updated_at_idx").on(table.updatedAt)]);

export const shopifyConnection = sqliteTable("shopify_connection", {
  id: integer("id").primaryKey(),
  shopDomain: text("shop_domain").notNull(),
  shopName: text("shop_name").notNull().default(""),
  credentialsCiphertext: text("credentials_ciphertext").notNull(),
  credentialsIv: text("credentials_iv").notNull(),
  scopesJson: text("scopes_json").notNull().default("[]"),
  connectedAt: text("connected_at").notNull(),
  updatedAt: text("updated_at").notNull(),
  lastTestedAt: text("last_tested_at").notNull(),
});

export const shopifyVariantSnapshot = sqliteTable("shopify_variant_snapshot", {
  variantId: text("variant_id").primaryKey(),
  productId: text("product_id").notNull(),
  sku: text("sku").notNull().default(""),
  title: text("title").notNull().default(""),
  productTitle: text("product_title").notNull().default(""),
  productStatus: text("product_status").notNull().default(""),
  barcode: text("barcode").notNull().default(""),
  importedAt: text("imported_at").notNull(),
});

export const shopifyItemMappings = sqliteTable("shopify_item_mapping", {
  variantId: text("variant_id").primaryKey(),
  productId: text("product_id").notNull(),
  shopifySku: text("shopify_sku").notNull().default(""),
  wohSku: text("woh_sku").notNull().default(""),
  workflowStatus: text("workflow_status").notNull().default("Unmatched"),
  confirmed: integer("confirmed", { mode: "boolean" }).notNull().default(false),
  assemblyComponents: text("assembly_components").notNull().default("[]"),
  knowledgeSource: text("knowledge_source").notNull().default(""),
  updatedAt: text("updated_at").notNull(),
});
