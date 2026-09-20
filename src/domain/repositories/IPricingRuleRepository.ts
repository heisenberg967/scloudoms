import { PricingRule } from '../models/PricingRule.js';

export interface IPricingRuleRepository {
  /**
   * Retrieves the currently active pricing and shipping rule.
   * If multiple rules are active, returns the most recently created one.
   * Returns null if no active rule exists.
   */
  getActiveRule(): Promise<PricingRule | null>;
}
