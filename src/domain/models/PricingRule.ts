import { DiscountRule } from '../services/PricingEngine.js';

export interface PricingRuleConfig {
  readonly id: string;
  readonly ruleName: string;
  readonly shippingRatePerKgKm: number;
  readonly maxShippingCostRatio: number;
  readonly discountTiers: readonly DiscountRule[];
  readonly isActive: boolean;
  readonly createdAt?: Date;
}

export class PricingRule {
  public readonly id: string;
  public readonly ruleName: string;
  public readonly shippingRatePerKgKm: number;
  public readonly maxShippingCostRatio: number;
  public readonly discountTiers: readonly DiscountRule[];
  public readonly isActive: boolean;
  public readonly createdAt: Date;

  constructor(config: PricingRuleConfig) {
    if (!config.id) throw new Error('PricingRule id is required');
    if (!Number.isFinite(config.shippingRatePerKgKm) || config.shippingRatePerKgKm < 0)
      throw new Error('shippingRatePerKgKm must be non-negative');
    if (
      !Number.isFinite(config.maxShippingCostRatio) ||
      config.maxShippingCostRatio <= 0 ||
      config.maxShippingCostRatio > 1
    ) {
      throw new Error('maxShippingCostRatio must be between 0 and 1');
    }

    if (!config.discountTiers.length || !config.discountTiers.some((t) => t.minQuantity === 0))
      throw new Error('Pricing tiers require a zero-quantity base tier');
    for (const tier of config.discountTiers) {
      if (
        !Number.isSafeInteger(tier.minQuantity) ||
        tier.minQuantity < 0 ||
        !Number.isFinite(tier.discountPercentage) ||
        tier.discountPercentage < 0 ||
        tier.discountPercentage >= 100
      )
        throw new Error('Invalid discount tier');
    }
    this.id = config.id;
    this.ruleName = config.ruleName;
    this.shippingRatePerKgKm = config.shippingRatePerKgKm;
    this.maxShippingCostRatio = config.maxShippingCostRatio;
    this.discountTiers = config.discountTiers;
    this.isActive = config.isActive;
    this.createdAt = config.createdAt ?? new Date();
  }
}
