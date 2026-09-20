import { Coordinates } from '../models/Coordinates.js';
import { Warehouse } from '../models/Warehouse.js';
import { Product } from '../models/Product.js';
import { OrderPricing, OrderShipping } from '../models/Order.js';
import { Allocation } from '../models/Allocation.js';
import { PricingRule } from '../models/PricingRule.js';
import { PricingEngine } from './PricingEngine.js';
import { FulfillmentOptimizer, IFulfillmentOptimizer } from './FulfillmentOptimizer.js';
import { ShippingValidityPolicy } from './ShippingValidityPolicy.js';

export interface OrderEvaluation {
  isValid: boolean;
  status: 'VALID' | 'INSUFFICIENT_STOCK' | 'INVALID_SHIPPING_COST_EXCEEDS_THRESHOLD';
  reason: string | null;
  product: Product;
  pricing: OrderPricing;
  shipping: OrderShipping;
  allocations: Allocation[];
  totalAvailableStock: number;
  requestedQuantity: number;
}

export class OrderEvaluator {
  /**
   * Orchestrates complete domain evaluation for an order quote or submission:
   *
   * DELIBERATE PIPELINE ORDERING:
   * 1. PricingEngine: Computes unit discounts and `netTotal` first.
   *    Business Rationale: The spec explicitly requires: "If shipping cost exceeds 15% of the
   *    order amount AFTER discount, the order is considered invalid." Therefore, the discounted
   *    subtotal (`netTotal`) must be computed before the shipping ceiling can be determined.
   * 2. FulfillmentOptimizer (IFulfillmentOptimizer): Calculates great-circle geodesic distances,
   *    sorts candidate warehouses by unit shipping cost, and greedily allocates stock.
   * 3. ShippingValidityPolicy: Asserts whether totalShippingCost <= 15% of netTotal.
   */
  public static evaluate(
    quantity: number,
    destination: Coordinates,
    product: Product,
    warehouses: readonly Warehouse[],
    optimizer: IFulfillmentOptimizer = new FulfillmentOptimizer(),
    pricingRule?: PricingRule | null
  ): OrderEvaluation {
    const totalAvailableStock = warehouses.reduce((sum, w) => sum + w.stock, 0);

    // 1. Pricing Policy (Computes netTotal after volume discounts, with dynamic rules support)
    const customTiers =
      pricingRule?.discountTiers && pricingRule.discountTiers.length > 0
        ? pricingRule.discountTiers
        : undefined;
    const pricing = PricingEngine.calculatePricing(quantity, product.unitPrice, customTiers);

    // 2. Fulfillment Optimization
    const shippingRate = pricingRule?.shippingRatePerKgKm;
    const maxRatio = pricingRule?.maxShippingCostRatio;

    const plan = optimizer.optimizeFulfillment(
      quantity,
      destination,
      warehouses,
      pricing.netTotal,
      shippingRate,
      maxRatio,
      product.unitWeightKg
    );

    // 3. Shipping Validity Policy
    const validity = ShippingValidityPolicy.evaluate(
      plan.shipping.totalShippingCost,
      pricing.netTotal,
      maxRatio
    );

    let status: 'VALID' | 'INSUFFICIENT_STOCK' | 'INVALID_SHIPPING_COST_EXCEEDS_THRESHOLD' =
      'VALID';
    let reason: string | null = null;
    let isValid = true;

    if (!plan.validation.isStockAvailable) {
      status = 'INSUFFICIENT_STOCK';
      reason = plan.validation.reason;
      isValid = false;
    } else if (!validity.isValid) {
      status = 'INVALID_SHIPPING_COST_EXCEEDS_THRESHOLD';
      reason = validity.reason;
      isValid = false;
    }

    return {
      isValid,
      status,
      reason,
      product,
      pricing,
      shipping: plan.shipping,
      allocations: plan.allocations,
      totalAvailableStock,
      requestedQuantity: quantity
    };
  }
}
