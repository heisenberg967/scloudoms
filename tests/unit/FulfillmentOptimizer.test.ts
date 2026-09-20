import { describe, it, expect } from 'vitest';
import { Coordinates } from '../../src/domain/models/Coordinates.js';
import { Warehouse } from '../../src/domain/models/Warehouse.js';
import { PricingEngine } from '../../src/domain/services/PricingEngine.js';
import { FulfillmentOptimizer } from '../../src/domain/services/FulfillmentOptimizer.js';

describe('FulfillmentOptimizer', () => {
  // Test fixture warehouses matching challenge specifications
  const createWarehouses = () => [
    new Warehouse({
      id: 'wh_la',
      name: 'Los Angeles',
      coordinates: Coordinates.create(33.9425, -118.408056),
      stock: 355
    }),
    new Warehouse({
      id: 'wh_ny',
      name: 'New York',
      coordinates: Coordinates.create(40.639722, -73.778889),
      stock: 578
    }),
    new Warehouse({
      id: 'wh_sp',
      name: 'São Paulo',
      coordinates: Coordinates.create(-23.435556, -46.473056),
      stock: 265
    }),
    new Warehouse({
      id: 'wh_par',
      name: 'Paris',
      coordinates: Coordinates.create(49.009722, 2.547778),
      stock: 694
    }),
    new Warehouse({
      id: 'wh_waw',
      name: 'Warsaw',
      coordinates: Coordinates.create(52.165833, 20.967222),
      stock: 245
    }),
    new Warehouse({
      id: 'wh_hk',
      name: 'Hong Kong',
      coordinates: Coordinates.create(22.308889, 113.914444),
      stock: 419
    })
  ];

  it('should fulfill order entirely from the nearest warehouse when it has sufficient stock', () => {
    const warehouses = createWarehouses();
    // Customer in Manhattan (very close to JFK / New York warehouse)
    const customerManhattan = Coordinates.create(40.7128, -74.006);
    const quantity = 30;
    const pricing = PricingEngine.calculatePricing(quantity);

    const plan = FulfillmentOptimizer.optimizeFulfillment(
      quantity,
      customerManhattan,
      warehouses,
      pricing.netTotal
    );

    expect(plan.validation.isValid).toBe(true);
    expect(plan.validation.status).toBe('VALID');
    expect(plan.allocations).toHaveLength(1);
    expect(plan.allocations[0].warehouseId).toBe('wh_ny');
    expect(plan.allocations[0].quantity).toBe(30);
    // Shipping cost should be modest and well within 15%
    expect(plan.shipping.shippingCostPercentageOfNetTotal).toBeLessThan(1.0);
    expect(plan.validation.isShippingCostValid).toBe(true);
  });

  it('should split order across multiple warehouses when nearest warehouse has insufficient stock', () => {
    const warehouses = createWarehouses();
    // Customer near Los Angeles (ordering 400 units, but LA only has 355 units)
    const customerNearLA = Coordinates.create(34.0522, -118.2437);
    const quantity = 400;
    const pricing = PricingEngine.calculatePricing(quantity);

    const plan = FulfillmentOptimizer.optimizeFulfillment(
      quantity,
      customerNearLA,
      warehouses,
      pricing.netTotal
    );

    expect(plan.validation.isValid).toBe(true);
    // Should allocate all 355 from LA, then next 45 from the second closest (New York)
    expect(plan.allocations.length).toBeGreaterThanOrEqual(2);
    expect(plan.allocations[0].warehouseId).toBe('wh_la');
    expect(plan.allocations[0].quantity).toBe(355);
    expect(plan.allocations[1].warehouseId).toBe('wh_ny');
    expect(plan.allocations[1].quantity).toBe(45);

    const totalAllocated = plan.allocations.reduce((sum, a) => sum + a.quantity, 0);
    expect(totalAllocated).toBe(400);
  });

  it('should return INSUFFICIENT_STOCK if requested quantity exceeds total network capacity', () => {
    const warehouses = createWarehouses();
    const totalNetworkStock = warehouses.reduce((sum, w) => sum + w.stock, 0); // 2556
    const excessQuantity = totalNetworkStock + 10;
    const pricing = PricingEngine.calculatePricing(excessQuantity);
    const customer = Coordinates.create(40.7128, -74.006);

    const plan = FulfillmentOptimizer.optimizeFulfillment(
      excessQuantity,
      customer,
      warehouses,
      pricing.netTotal
    );

    expect(plan.validation.isValid).toBe(false);
    expect(plan.validation.status).toBe('INSUFFICIENT_STOCK');
    expect(plan.validation.isStockAvailable).toBe(false);
    expect(plan.allocations).toHaveLength(0);
  });

  it('should flag order as INVALID when shipping cost exceeds 15% of net total', () => {
    const warehouses = createWarehouses();
    // Shipping to McMurdo Station, Antarctica (-77.846, 166.676)
    // Very far from any warehouse (over 9,000+ km from closest)
    const antarctica = Coordinates.create(-77.846, 166.676);
    const quantity = 1; // 1 unit: net total = $150. 15% threshold = $22.50
    // Distance from Hong Kong or São Paulo to Antarctica > 10,000 km
    // Shipping cost = 10,000 km * 0.365 kg * 0.01 = $36.50 > $22.50 threshold
    const pricing = PricingEngine.calculatePricing(quantity);

    const plan = FulfillmentOptimizer.optimizeFulfillment(
      quantity,
      antarctica,
      warehouses,
      pricing.netTotal
    );

    expect(plan.validation.isValid).toBe(false);
    expect(plan.validation.status).toBe('INVALID_SHIPPING_COST_EXCEEDS_THRESHOLD');
    expect(plan.validation.isShippingCostValid).toBe(false);
    expect(
      plan.shipping.totalShippingCost.isGreaterThan(plan.shipping.maxAllowedShippingCost)
    ).toBe(true);
    expect(plan.validation.reason).toContain('exceeds the maximum allowed 15% threshold');
  });
});
