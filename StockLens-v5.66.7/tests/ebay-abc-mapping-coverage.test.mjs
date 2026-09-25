import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const source = await readFile(new URL("../app/page.tsx", import.meta.url), "utf8");

test("eBay mapping reads every ABC period and trace source", () => {
  assert.match(source, /\^eBay ABC \\d\+ Months\$/);
  assert.match(source, /sheetName === "Calculation Trace"/);
  assert.match(source, /sheetName === "Order Calculation Trace"/);
  assert.match(source, /sheetName === "Component Where Used"/);
  assert.match(source, /sheetName === "Undetermined Reasons"/);
  assert.doesNotMatch(source, /loadEbayAbcListingCandidates\(token\)\.catch/);
});

test("mapping rebuild stops instead of silently omitting an ABC-history SKU", () => {
  assert.match(source, /const missingAbcMappings = abcHistoryListings\.filter/);
  assert.match(source, /ABC-history reconciliation stopped/);
  assert.match(source, /all \$\{abcHistoryListings\.length\.toLocaleString\(\)\} ABC-history rows verified present/);
});

test("ABC resolves confirmed assembly components through all WOH reference keys", () => {
  assert.match(source, /const savedWohRow = savedWohSku \? findWohByReference\(wohRows, savedWohSku\)/);
  assert.match(source, /const resolvedRow = savedWohRow \|\| exactAliasRow \|\| learnedWohRow/);
  assert.match(source, /resolvedComponents\.some\(\(component: \{ row\?: Row \}\) => !component\.row\)/);
});

test("ABC can reopen retained analyses and switch their saved periods", () => {
  assert.match(source, /listEbayAbcSavedRuns/);
  assert.match(source, /parseSavedEbayAbcWorkbook/);
  assert.match(source, /Open selected analysis/);
  assert.match(source, /selectEbayAbcPeriod/);
});

test("eBay mapping shows calculated WOH cost instead of old catalog columns", () => {
  assert.match(source, /calculatedCost: "Calculated item cost"/);
  assert.match(source, /ebayMappingCalculatedCost\(item, rows\)/);
  assert.doesNotMatch(source, /wohDescription: "WOH description", available: "Available", price: "Price"/);
});
