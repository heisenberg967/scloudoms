import { Money } from '../models/Money.js';
import { SCOS_STATION_P1_PRO } from '../models/Product.js';
import { OrderPricing } from '../models/Order.js';

export interface DiscountRule {
  readonly minQuantity: number;
  readonly discountPercentage: number;
  readonly label: string;
}

export class PricingEngine {
  // Volume discount rules configured in descending order of minQuantity
  public static readonly DEFAULT_DISCOUNT_TIERS: readonly DiscountRule[] = [
    { minQuantity: 250, discountPercentage: 20, label: '20% discount (250+ units)' },
    { minQuantity: 100, discountPercentage: 15, label: '15% discount (100-249 units)' },
    { minQuantity: 50, discountPercentage: 10, label: '10% discount (50-99 units)' },
    { minQuantity: 25, discountPercentage: 5, label: '5% discount (25-49 units)' },
    { minQuantity: 0, discountPercentage: 0, label: 'Standard pricing (0-24 units)' }
  ];

  /**
   * Resolves the applicable discount percentage and tier for a given order quantity.
   */
  public static resolveDiscountTier(
    quantity: number,
    tiers: readonly DiscountRule[] = this.DEFAULT_DISCOUNT_TIERS
  ): DiscountRule {
    if (quantity <= 0) {
      throw new Error(`Quantity must be a positive integer, received ${quantity}`);
    }

    const tier = tiers.find((t) => quantity >= t.minQuantity);
    return tier ?? tiers[tiers.length - 1];
  }

  /**
   * Computes complete pricing breakdown for an order quantity of SCOS Station P1 Pro devices.
   */
  public static calculatePricing(
    quantity: number,
    unitPrice: Money = Money.fromDollars(SCOS_STATION_P1_PRO.unitPriceUsd),
    customTiers?: readonly DiscountRule[]
  ): OrderPricing {
    if (quantity <= 0 || !Number.isInteger(quantity)) {
      throw new Error(`Order quantity must be a positive integer, received ${quantity}`);
    }

    const discountTier = this.resolveDiscountTier(quantity, customTiers);
    const grossTotal = unitPrice.multiply(quantity);
    const discountAmount = grossTotal.percentage(discountTier.discountPercentage);
    const netTotal = grossTotal.subtract(discountAmount);

    return {
      unitPrice,
      quantity,
      grossTotal,
      discountTier: discountTier.label,
      discountPercentage: discountTier.discountPercentage,
      discountAmount,
      netTotal
    };
  }
}
