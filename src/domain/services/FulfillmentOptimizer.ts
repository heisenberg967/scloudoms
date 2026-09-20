import { Coordinates } from '../models/Coordinates.js';
import { Warehouse } from '../models/Warehouse.js';
import { Allocation } from '../models/Allocation.js';
import { Money } from '../models/Money.js';
import {
  SCOS_STATION_P1_PRO,
  SHIPPING_RATE_PER_KG_KM,
  MAX_SHIPPING_COST_RATIO_OF_NET_TOTAL
} from '../models/Product.js';
import { DistanceCalculator } from './DistanceCalculator.js';
import { OrderShipping } from '../models/Order.js';

export interface FulfillmentCandidate {
  warehouse: Warehouse;
  distanceKm: number;
}

export type FulfillmentValidationStatus =
  | 'VALID'
  | 'INVALID_SHIPPING_COST_EXCEEDS_THRESHOLD'
  | 'INSUFFICIENT_STOCK';

export interface FulfillmentValidationDetails {
  status: FulfillmentValidationStatus;
  isValid: boolean;
  reason: string | null;
  isShippingCostValid: boolean;
  isStockAvailable: boolean;
  totalAvailableStock: number;
  requestedQuantity: number;
}

export interface FulfillmentPlan {
  validation: FulfillmentValidationDetails;
  shipping: OrderShipping;
  allocations: Allocation[];
}

/**
 * Interface representing a fulfillment allocation strategy.
 *
 * Architectural Decision Record (ADR):
 * This interface decouples OrderEvaluator from the specific optimization algorithm.
 * While the current problem has strictly linear shipping cost per unit (making greedy allocation
 * provably optimal via exchange argument), introducing a fixed handling fee per warehouse touched
 * (e.g. $5 per shipment) transforms this into an NP-hard Capacitated Facility Location / Knapsack problem.
 * Having IFulfillmentOptimizer allows swapping between Linear Greedy and Branch-and-Bound / MILP
 * without modifying domain evaluators or use cases.
 */
export interface IFulfillmentOptimizer {
  optimizeFulfillment(
    quantity: number,
    destination: Coordinates,
    warehouses: readonly Warehouse[],
    netTotal: Money,
    shippingRatePerKgKm?: number,
    maxShippingCostRatio?: number,
    unitWeightKg?: number
  ): FulfillmentPlan;
}

/**
 * Mathematical Proof of Optimality via Exchange Argument:
 *
 * Problem Formulation:
 * Minimize total shipping cost C = sum_{i=1}^M (q_i * c_i)
 * Subject to:
 *   1. sum_{i=1}^M q_i = Q (satisfy total order demand)
 *   2. 0 <= q_i <= S_i for all i in {1..M} (cannot exceed available stock at warehouse i)
 * where c_i = distance(w_i, destination) * unitWeight * ratePerKgKm is strictly positive
 * and constant per unit for warehouse i (purely linear cost function with zero fixed overhead).
 *
 * Exchange Argument (Proof by Contradiction):
 * Suppose an allocation A* = (q_1*, ..., q_M*) is optimal, but does not allocate greedily
 * by non-decreasing unit cost c_i. Then there exists a pair of warehouses (j, k) such that:
 *   c_k < c_j  (warehouse k has strictly lower shipping cost per unit than warehouse j)
 *   q_j* > 0   (warehouse j was allocated units)
 *   q_k* < S_k (warehouse k has unused capacity delta = min(q_j*, S_k - q_k*) > 0)
 *
 * Construct an alternative allocation A' by transferring delta units from warehouse j to warehouse k:
 *   q_j' = q_j* - delta >= 0
 *   q_k' = q_k* + delta <= S_k
 *   q_i' = q_i* for all i not in {j, k}
 *
 * Both capacity and demand constraints remain satisfied in A'.
 * The change in total shipping cost is:
 *   Delta C = Cost(A') - Cost(A*)
 *           = (delta * c_k - delta * c_j)
 *           = delta * (c_k - c_j) < 0   (since delta > 0 and c_k < c_j).
 *
 * Thus, Cost(A') < Cost(A*), which contradicts the assumption that A* was cost-minimal.
 * Therefore, no optimal allocation can allocate units from a costlier warehouse while a cheaper
 * warehouse has remaining stock. Hence, sorting by unit cost c_i and filling greedily guarantees
 * the global minimum in O(M log M) time and O(M) space.
 */
export class FulfillmentOptimizer implements IFulfillmentOptimizer {
  public optimizeFulfillment(
    quantity: number,
    destination: Coordinates,
    warehouses: readonly Warehouse[],
    netTotal: Money,
    shippingRatePerKgKm: number = SHIPPING_RATE_PER_KG_KM,
    maxShippingCostRatio: number = MAX_SHIPPING_COST_RATIO_OF_NET_TOTAL,
    unitWeightKg: number = SCOS_STATION_P1_PRO.unitWeightKg
  ): FulfillmentPlan {
    return FulfillmentOptimizer.optimizeFulfillment(
      quantity,
      destination,
      warehouses,
      netTotal,
      shippingRatePerKgKm,
      maxShippingCostRatio,
      unitWeightKg
    );
  }

  /**
   * Computes the globally optimal (cost-minimizing) warehouse allocation plan
   * to fulfill an order of a given quantity to the destination coordinates.
   */
  public static optimizeFulfillment(
    quantity: number,
    destination: Coordinates,
    warehouses: readonly Warehouse[],
    netTotal: Money,
    shippingRatePerKgKm: number = SHIPPING_RATE_PER_KG_KM,
    maxShippingCostRatio: number = MAX_SHIPPING_COST_RATIO_OF_NET_TOTAL,
    unitWeightKg: number = SCOS_STATION_P1_PRO.unitWeightKg
  ): FulfillmentPlan {
    if (quantity <= 0 || !Number.isInteger(quantity)) {
      throw new Error(`Quantity must be a positive integer, received ${quantity}`);
    }

    const totalAvailableStock = warehouses.reduce((sum, w) => sum + w.stock, 0);

    // 1. Check network stock availability
    if (totalAvailableStock < quantity) {
      const emptyShipping: OrderShipping = {
        ratePerKgKm: shippingRatePerKgKm,
        totalWeightKg: Number((quantity * unitWeightKg).toFixed(3)),
        totalDistanceKm: 0,
        totalShippingCost: Money.zero(),
        shippingCostPercentageOfNetTotal: 0,
        maxAllowedShippingCost: netTotal.floorPercentage(maxShippingCostRatio * 100),
        maxAllowedPercentage: maxShippingCostRatio * 100
      };

      return {
        validation: {
          status: 'INSUFFICIENT_STOCK',
          isValid: false,
          reason: `Insufficient stock: Requested ${quantity} units, but only ${totalAvailableStock} units available across all warehouses.`,
          isShippingCostValid: false,
          isStockAvailable: false,
          totalAvailableStock,
          requestedQuantity: quantity
        },
        shipping: emptyShipping,
        allocations: []
      };
    }

    // 2. Score and sort candidate warehouses by distance (unit shipping cost)
    // Stable tie-breaker: warehouse.id ascending for deterministic behavior
    const candidates: FulfillmentCandidate[] = warehouses
      .map((w) => {
        const distanceKm = DistanceCalculator.calculateDistanceKm(w.coordinates, destination);
        return {
          warehouse: w,
          distanceKm
        };
      })
      .sort((a, b) => {
        if (a.distanceKm !== b.distanceKm) {
          return a.distanceKm - b.distanceKm;
        }
        return a.warehouse.id.localeCompare(b.warehouse.id);
      });

    // 3. Greedy allocation
    let remainingToAllocate = quantity;
    const allocations: Allocation[] = [];
    let accumulatedShippingCents = 0;
    let accumulatedDistanceKm = 0;

    for (const candidate of candidates) {
      if (remainingToAllocate <= 0) break;
      if (candidate.warehouse.stock <= 0) continue;

      const allocatedQty = Math.min(candidate.warehouse.stock, remainingToAllocate);
      const allocatedWeightKg = allocatedQty * unitWeightKg;

      // Cost = distance * weight * rate
      const shippingCostDollars = candidate.distanceKm * allocatedWeightKg * shippingRatePerKgKm;
      const shippingCostMoney = Money.fromDollars(shippingCostDollars);

      allocations.push(
        new Allocation({
          warehouseId: candidate.warehouse.id,
          warehouseName: candidate.warehouse.name,
          warehouseCoordinates: candidate.warehouse.coordinates,
          distanceKm: candidate.distanceKm,
          quantity: allocatedQty,
          weightKg: allocatedWeightKg,
          shippingCost: shippingCostMoney
        })
      );

      accumulatedShippingCents += shippingCostMoney.toCents();
      accumulatedDistanceKm += candidate.distanceKm;
      remainingToAllocate -= allocatedQty;
    }

    const totalShippingCost = Money.fromCents(accumulatedShippingCents);
    const maxAllowedShippingCost = netTotal.floorPercentage(maxShippingCostRatio * 100);
    const maxAllowedPercentage = maxShippingCostRatio * 100;

    const shippingCostPercentageOfNetTotal =
      netTotal.toCents() > 0
        ? Number(((totalShippingCost.toCents() / netTotal.toCents()) * 100).toFixed(2))
        : 0;

    // Rule: "If shipping cost exceeds threshold of the order amount after discount, the order is considered invalid"
    const isShippingCostValid = totalShippingCost.isLessThanOrEqual(maxAllowedShippingCost);

    let status: FulfillmentValidationStatus = 'VALID';
    let reason: string | null = null;

    if (!isShippingCostValid) {
      status = 'INVALID_SHIPPING_COST_EXCEEDS_THRESHOLD';
      reason = `Shipping cost of $${totalShippingCost.toDollars().toFixed(2)} (${shippingCostPercentageOfNetTotal.toFixed(2)}% of net total) exceeds the maximum allowed ${maxAllowedPercentage}% threshold ($${maxAllowedShippingCost.toDollars().toFixed(2)}).`;
    }

    const totalWeightKg = Number((quantity * unitWeightKg).toFixed(3));

    const shipping: OrderShipping = {
      ratePerKgKm: shippingRatePerKgKm,
      totalWeightKg,
      totalDistanceKm: Number(accumulatedDistanceKm.toFixed(2)),
      totalShippingCost,
      shippingCostPercentageOfNetTotal,
      maxAllowedShippingCost,
      maxAllowedPercentage
    };

    return {
      validation: {
        status,
        isValid: isShippingCostValid,
        reason,
        isShippingCostValid,
        isStockAvailable: true,
        totalAvailableStock,
        requestedQuantity: quantity
      },
      shipping,
      allocations
    };
  }
}
