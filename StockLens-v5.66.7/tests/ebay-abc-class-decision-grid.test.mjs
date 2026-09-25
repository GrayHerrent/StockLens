import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const source = await readFile(new URL("../app/page.tsx", import.meta.url), "utf8");
const styles = await readFile(new URL("../app/globals.css", import.meta.url), "utf8");

test("ABC class decision grid exposes every profit input", () => {
  for (const label of ["Item revenue · eBay subtotal", "Buyer-paid shipping", "eBay fees", "Advertising", "Refunds", "Shipping-label cost", "Net eBay proceeds", "Landed / assembly cost", "Profit"]) {
    assert.match(source, new RegExp(`label: \\\"${label.replaceAll("/", "\\/")}\\\"`));
  }
  assert.match(source, /Net eBay proceeds − landed \/ assembly cost = profit/);
});

test("ABC trace identifies source systems and quantity normalization", () => {
  assert.match(source, /EBAY FULFILLMENT API/);
  assert.match(source, /EBAY FINANCES API/);
  assert.match(source, /WOH\.XLSM/);
  assert.match(source, /Legacy source multiplied quantity twice; normalized once/);
  assert.match(source, /Revenue-to-proceeds audit/);
  assert.match(styles, /\.abc-source-flow/);
  assert.match(styles, /\.abc-trace-waterfall/);
});

test("ABC class decision grid supports independent sorting filtering and sizing", () => {
  assert.match(source, /filteredSortedEbayAbcDecisionItems/);
  assert.match(source, /toggleEbayAbcDecisionSort/);
  assert.match(source, /emptyEbayAbcDecisionFilters/);
  assert.match(source, /resizeEbayAbcDecisionColumn/);
  assert.match(source, /Class decision table frame width/);
  assert.match(source, /setEbayAbcDecisionVisibleColumns/);
  assert.match(styles, /\.abc-decision-table-wrap/);
  assert.match(styles, /\.abc-sort-button/);
});

test("ABC table browser includes per-unit margin diagnostics", () => {
  assert.match(source, /TABLE INDEX/);
  assert.match(source, /Per-unit diagnostics/);
  assert.match(source, /profitCostPercent/);
  assert.match(source, /profitRevenuePercent/);
  assert.match(source, /High revenue · poor margin/);
  assert.match(source, /setEbayAbcPerUnitVisibleColumns/);
  assert.match(styles, /\.abc-results-browser/);
  assert.match(styles, /\.abc-high-revenue-warning/);
});
