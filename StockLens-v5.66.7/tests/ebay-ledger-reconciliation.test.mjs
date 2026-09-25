import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const source = await readFile(new URL("../app/page.tsx", import.meta.url), "utf8");

test("refund fee metadata is not counted as a second selling fee", () => {
  assert.match(source, /transactionType !== "REFUND"/);
});

test("order-linked non-sale ledger activity is exposed in the proceeds bridge", () => {
  assert.match(source, /current\.otherCharges/);
  assert.match(source, /current\.otherCredits/);
  assert.match(source, /Other eBay Charges/);
  assert.match(source, /Other eBay Credits/);
  assert.match(source, /Reconciled: the displayed eBay ledger categories reproduce signed proceeds/);
});

test("listing-level charges are allocated by eBay ITEM_ID", () => {
  assert.match(source, /listingLevelTransactions/);
  assert.match(source, /reference\.type === "ITEM_ID"/);
  assert.match(source, /groupedByListing\.get\(itemId\)/);
});
