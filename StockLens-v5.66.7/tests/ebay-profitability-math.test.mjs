import assert from "node:assert/strict";
import test from "node:test";

const loadModule = async () => import(new URL("../lib/ebay-profitability-math.ts", import.meta.url));

test("multi-quantity eBay line subtotal is not multiplied twice", async () => {
  const { normalizedEbayOrderLineSubtotal } = await loadModule();
  assert.equal(normalizedEbayOrderLineSubtotal(6998, 10), 699.8);
  assert.ok(Math.abs(normalizedEbayOrderLineSubtotal(2519.28, 6) - 419.88) < 1e-9);
  assert.equal(normalizedEbayOrderLineSubtotal(66.99, 1), 66.99);
});

test("recovered report shipping is deducted exactly once", async () => {
  const { deductRecoveredShippingFromSignedProceeds } = await loadModule();
  assert.equal(deductRecoveredShippingFromSignedProceeds(100, 12, false), 88);
  assert.equal(deductRecoveredShippingFromSignedProceeds(88, 12, true), 88);
});
