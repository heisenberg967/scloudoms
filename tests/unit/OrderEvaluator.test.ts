import { describe, it, expect } from 'vitest';
import { Coordinates } from '../../src/domain/models/Coordinates.js';
import { Warehouse } from '../../src/domain/models/Warehouse.js';
import { SCOS_STATION_P1_PRO_ENTITY } from '../../src/domain/models/Product.js';
import { OrderEvaluator } from '../../src/domain/services/OrderEvaluator.js';
import { ShippingValidityPolicy } from '../../src/domain/services/ShippingValidityPolicy.js';
import { Money } from '../../src/domain/models/Money.js';

describe('OrderEvaluator and ShippingValidityPolicy', () => {
  const warehouses = [
    new Warehouse({
      id: 'wh_ny',
      name: 'New York',
      coordinates: Coordinates.create(40.639722, -73.778889),
      stock: 500
    })
  ];

  it('ShippingValidityPolicy should pass when shipping cost <= 15% of net total', () => {
    const netTotal = Money.fromDollars(1000);
    const shippingCost = Money.fromDollars(150); // Exactly 15%
    const result = ShippingValidityPolicy.evaluate(shippingCost, netTotal);

    expect(result.isValid).toBe(true);
    expect(result.reason).toBeNull();
  });

  it('ShippingValidityPolicy should fail when shipping cost > 15% of net total', () => {
    const netTotal = Money.fromDollars(1000);
    const shippingCost = Money.fromDollars(150.01); // Exceeds 15%
    const result = ShippingValidityPolicy.evaluate(shippingCost, netTotal);

    expect(result.isValid).toBe(false);
    expect(result.reason).toContain('exceeds the maximum allowed 15% threshold');
  });

  it('does not round a fractional-cent shipping ceiling upwards', () => {
    const net = Money.fromDollars(3562.50);
    expect(ShippingValidityPolicy.evaluate(Money.fromDollars(534.37), net).isValid).toBe(true);
    expect(ShippingValidityPolicy.evaluate(Money.fromDollars(534.38), net).isValid).toBe(false);
  });

  it('OrderEvaluator should orchestrate pricing, fulfillment, and validity seamlessly', () => {
    const customer = Coordinates.create(40.7128, -74.006); // NYC
    const quantity = 30;

    const evaluation = OrderEvaluator.evaluate(
      quantity,
      customer,
      SCOS_STATION_P1_PRO_ENTITY,
      warehouses
    );

    expect(evaluation.isValid).toBe(true);
    expect(evaluation.status).toBe('VALID');
    expect(evaluation.pricing.grossTotal.toDollars()).toBe(4500.0);
    expect(evaluation.pricing.discountPercentage).toBe(5); // 25+ units tier = 5%
    expect(evaluation.allocations).toHaveLength(1);
    expect(evaluation.allocations[0].warehouseId).toBe('wh_ny');
  });
});
