import assert from "node:assert/strict";
import test from "node:test";
import { ebayReviewFingerprint, normalizeEbayReviewSku } from "../lib/ebay-review-fingerprint.ts";

test("review fingerprints use one browser/server SKU normalization contract", () => {
  const rows = [
    { listingId: "1002", ebaySku: "Galvanized-Bracket", currentQuantity: 4, recommendedQuantity: 2 },
    { listingId: "1001", ebaySku: "BS-3/4-Galv", currentQuantity: 0, recommendedQuantity: 5 },
  ];
  assert.equal(normalizeEbayReviewSku("BS-3/4-Galv"), "bs34galv");
  assert.notEqual(normalizeEbayReviewSku("BS-3/4-Galv"), normalizeEbayReviewSku("BS-3/4-Gal"));
  assert.equal(ebayReviewFingerprint(rows), ebayReviewFingerprint([...rows].reverse()));
  assert.match(ebayReviewFingerprint(rows), /^[A-Z0-9]{7}$/);
});
