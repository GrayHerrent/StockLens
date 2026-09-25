export function normalizedEbayOrderLineSubtotal(grossAmount: number, quantity: number) {
  return grossAmount / Math.max(1, quantity || 1);
}

export function deductRecoveredShippingFromSignedProceeds(
  signedProceeds: number,
  recoveredShippingCost: number,
  shippingAlreadyInSignedTransactions: boolean,
) {
  return shippingAlreadyInSignedTransactions ? signedProceeds : signedProceeds - recoveredShippingCost;
}
