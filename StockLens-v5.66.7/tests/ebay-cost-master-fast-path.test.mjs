import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const page = await readFile(new URL("../app/page.tsx", import.meta.url), "utf8");
const worker = await readFile(new URL("../worker/index.ts", import.meta.url), "utf8");
const schema = await readFile(new URL("../db/schema.ts", import.meta.url), "utf8");

test("quick eBay cost correction queries the indexed live master", () => {
  const start = page.indexOf("async function loadEbayQuickCostMaster");
  const end = page.indexOf("async function openAssemblyLookupCorrection", start);
  const implementation = page.slice(start, end);
  assert.match(implementation, /\/api\/ebay\/cost-items/);
  assert.doesNotMatch(implementation, /loadWohRowsWithStock/);
  assert.match(implementation, /if \(!data\?\.costIndexRows\)/);
});

test("row corrections defer Excel snapshots and ABC uses cached-period recalculation", () => {
  const start = page.indexOf("async function saveEbayMapping");
  const end = page.indexOf("function assignEbayMapping", start);
  const implementation = page.slice(start, end);
  assert.doesNotMatch(implementation, /scheduleEbayDriveSync/);
  assert.match(implementation, /snapshotPending/);
  assert.match(implementation, /recalculateEbayAbcFromCorrectedCosts/);
  assert.match(page, /cost-items\?export=1/);
});

test("live cost index and snapshot state are durable and queryable", () => {
  assert.match(schema, /sqliteTable\("woh_cost_index"/);
  assert.match(schema, /sqliteTable\("ebay_cost_snapshot_state"/);
  assert.match(worker, /url\.pathname === "\/api\/ebay\/woh-costs"/);
  assert.match(worker, /url\.pathname === "\/api\/ebay\/cost-snapshot"/);
  assert.match(schema, /idx_woh_cost_index_sku/);
});
