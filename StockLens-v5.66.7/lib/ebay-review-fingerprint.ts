export type EbayReviewFingerprintRow = {
  listingId: string;
  ebaySku?: string;
  currentQuantity: number;
  recommendedQuantity: number;
};

export const normalizeEbayReviewSku = (value: unknown) => String(value ?? "")
  .trim()
  .toLowerCase()
  .replace(/[^a-z0-9]/g, "");

export const ebayReviewFingerprint = <Row extends EbayReviewFingerprintRow>(rows: Row[]) => {
  const signature = [...rows]
    .sort((left, right) => `${left.listingId}:${normalizeEbayReviewSku(left.ebaySku)}`.localeCompare(`${right.listingId}:${normalizeEbayReviewSku(right.ebaySku)}`))
    .map((row) => `${row.listingId}\u001f${normalizeEbayReviewSku(row.ebaySku)}\u001f${Number(row.currentQuantity)}\u001f${Number(row.recommendedQuantity)}`)
    .join("\u001e");
  let hash = 2166136261;
  for (let index = 0; index < signature.length; index += 1) {
    hash ^= signature.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(36).toUpperCase().padStart(7, "0");
};
