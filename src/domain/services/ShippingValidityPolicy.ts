import { Money } from '../models/Money.js';
import { MAX_SHIPPING_COST_RATIO_OF_NET_TOTAL } from '../models/Product.js';

export interface ShippingValidityResult {
  isValid: boolean;
  maxAllowedShippingCost: Money;
  maxAllowedPercentage: number;
  shippingCostPercentageOfNetTotal: number;
  reason: string | null;
}

export class ShippingValidityPolicy {
  public static readonly MAX_ALLOWED_RATIO = MAX_SHIPPING_COST_RATIO_OF_NET_TOTAL; // 0.15

  /**
   * Evaluates if total shipping cost is within the allowable ratio of net order total.
   */
  public static evaluate(
    shippingCost: Money,
    netTotal: Money,
    maxAllowedRatio: number = this.MAX_ALLOWED_RATIO
  ): ShippingValidityResult {
    const maxAllowedPercentage = maxAllowedRatio * 100;
    const maxAllowedShippingCost = netTotal.floorPercentage(maxAllowedPercentage);

    const shippingCostPercentageOfNetTotal =
      netTotal.toCents() > 0
        ? Number(((shippingCost.toCents() / netTotal.toCents()) * 100).toFixed(2))
        : 0;

    const isValid = shippingCost.isLessThanOrEqual(maxAllowedShippingCost);

    let reason: string | null = null;
    if (!isValid) {
      reason = `Shipping cost of $${shippingCost.toDollars().toFixed(2)} (${shippingCostPercentageOfNetTotal.toFixed(2)}% of net total) exceeds the maximum allowed ${maxAllowedPercentage}% threshold ($${maxAllowedShippingCost.toDollars().toFixed(2)}).`;
    }

    return {
      isValid,
      maxAllowedShippingCost,
      maxAllowedPercentage,
      shippingCostPercentageOfNetTotal,
      reason
    };
  }
}
