import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const source = await readFile(new URL("../app/page.tsx", import.meta.url), "utf8");

test("exact shipping-label status names the newest covered day", () => {
  assert.match(source, /Exact shipping-label costs available through/);
  assert.match(source, /last CSV import/);
});

test("eBay financial history fetches only records newer than its saved checkpoint", () => {
  assert.match(source, /previousThrough\.getTime\(\) \+ 1/);
  assert.match(source, /orderPreviousThrough\.getTime\(\) \+ 1/);
  assert.doesNotMatch(source, /previousThrough\.getTime\(\) - 7 \* 24/);
  assert.doesNotMatch(source, /orderPreviousThrough\.getTime\(\) - 7 \* 24/);
  assert.match(source, /Google Drive history loaded/);
  assert.match(source, /cacheReuseNote/);
});

test("eBay history appends changed rows without rewriting prior Drive parts", () => {
  assert.match(source, /EBAY_PROFITABILITY_MAX_TRANSACTIONS_PER_FILE = 50_000/);
  assert.match(source, /EBAY_PROFITABILITY_MAX_ORDERS_PER_FILE = 25_000/);
  assert.match(source, /existingHistoryFiles: string\[\]/);
  assert.match(source, /ebayProfitabilityCacheWorkbook\(changedTransactions, changedOrders/);
  assert.match(source, /Existing historical parts are never rewritten/);
  assert.match(source, /historyFiles\.push\(checkpointName\)/);
  assert.match(source, /is listed in the eBay financial-history index but is missing from Google Drive/);
});

test("older Drive histories recover their cursors from saved row dates", () => {
  assert.match(source, /transactionExtent = dateExtent/);
  assert.match(source, /orderExtent = dateExtent/);
  assert.match(source, /validIso\(meta\.get\("Cached Through"\)/);
});
