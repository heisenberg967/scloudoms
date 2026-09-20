import { IPricingRuleRepository } from '../../../domain/repositories/IPricingRuleRepository.js';
import { PricingRule } from '../../../domain/models/PricingRule.js';
import { SqlConnection } from '../PostgresClient.js';

export class SqlPricingRuleRepository implements IPricingRuleRepository {
  constructor(private readonly db: SqlConnection) {}
  async getActiveRule(): Promise<PricingRule | null> {
    const [r] = await this.db.query(
      'SELECT * FROM pricing_rules WHERE is_active = 1 ORDER BY created_at DESC, id DESC LIMIT 1'
    );
    if (!r) return null;
    const tiers = JSON.parse(r.discount_tiers_json);
    if (!Array.isArray(tiers) || !tiers.length) throw new Error('Invalid pricing tiers');
    return new PricingRule({
      id: r.id,
      ruleName: r.rule_name,
      shippingRatePerKgKm: r.shipping_rate_per_kg_km,
      maxShippingCostRatio: r.max_shipping_cost_ratio,
      discountTiers: tiers
        .map((t) => ({
          minQuantity: t.minQuantity ?? t.minUnits,
          discountPercentage: t.discountPercentage,
          label: t.label ?? t.tier
        }))
        .sort((a, b) => b.minQuantity - a.minQuantity),
      isActive: true,
      createdAt: new Date(r.created_at)
    });
  }
}
