import { describe, it, expect } from 'vitest';
import { PricingEngine } from '../../src/domain/services/PricingEngine.js';

describe('PricingEngine', () => {
  it('should apply 0% discount for orders under 25 units', () => {
    const p1 = PricingEngine.calculatePricing(1);
    expect(p1.discountPercentage).toBe(0);
    expect(p1.grossTotal.toDollars()).toBe(150.0);
    expect(p1.discountAmount.toDollars()).toBe(0.0);
    expect(p1.netTotal.toDollars()).toBe(150.0);

    const p24 = PricingEngine.calculatePricing(24);
    expect(p24.discountPercentage).toBe(0);
    expect(p24.grossTotal.toDollars()).toBe(3600.0);
    expect(p24.discountAmount.toDollars()).toBe(0.0);
    expect(p24.netTotal.toDollars()).toBe(3600.0);
  });

  it('should apply 5% discount for orders between 25 and 49 units', () => {
    const p25 = PricingEngine.calculatePricing(25);
    expect(p25.discountPercentage).toBe(5);
    expect(p25.grossTotal.toDollars()).toBe(3750.0);
    expect(p25.discountAmount.toDollars()).toBe(187.5);
    expect(p25.netTotal.toDollars()).toBe(3562.5);

    const p49 = PricingEngine.calculatePricing(49);
    expect(p49.discountPercentage).toBe(5);
    expect(p49.grossTotal.toDollars()).toBe(7350.0);
    expect(p49.discountAmount.toDollars()).toBe(367.5);
    expect(p49.netTotal.toDollars()).toBe(6982.5);
  });

  it('should apply 10% discount for orders between 50 and 99 units', () => {
    const p50 = PricingEngine.calculatePricing(50);
    expect(p50.discountPercentage).toBe(10);
    expect(p50.grossTotal.toDollars()).toBe(7500.0);
    expect(p50.discountAmount.toDollars()).toBe(750.0);
    expect(p50.netTotal.toDollars()).toBe(6750.0);

    const p99 = PricingEngine.calculatePricing(99);
    expect(p99.discountPercentage).toBe(10);
    expect(p99.grossTotal.toDollars()).toBe(14850.0);
    expect(p99.discountAmount.toDollars()).toBe(1485.0);
    expect(p99.netTotal.toDollars()).toBe(13365.0);
  });

  it('should apply 15% discount for orders between 100 and 249 units', () => {
    const p100 = PricingEngine.calculatePricing(100);
    expect(p100.discountPercentage).toBe(15);
    expect(p100.grossTotal.toDollars()).toBe(15000.0);
    expect(p100.discountAmount.toDollars()).toBe(2250.0);
    expect(p100.netTotal.toDollars()).toBe(12750.0);

    const p249 = PricingEngine.calculatePricing(249);
    expect(p249.discountPercentage).toBe(15);
    expect(p249.grossTotal.toDollars()).toBe(37350.0);
    expect(p249.discountAmount.toDollars()).toBe(5602.5);
    expect(p249.netTotal.toDollars()).toBe(31747.5);
  });

  it('should apply 20% discount for orders of 250 units and above', () => {
    const p250 = PricingEngine.calculatePricing(250);
    expect(p250.discountPercentage).toBe(20);
    expect(p250.grossTotal.toDollars()).toBe(37500.0);
    expect(p250.discountAmount.toDollars()).toBe(7500.0);
    expect(p250.netTotal.toDollars()).toBe(30000.0);

    const p500 = PricingEngine.calculatePricing(500);
    expect(p500.discountPercentage).toBe(20);
    expect(p500.grossTotal.toDollars()).toBe(75000.0);
    expect(p500.discountAmount.toDollars()).toBe(15000.0);
    expect(p500.netTotal.toDollars()).toBe(60000.0);
  });

  it('should throw an error for non-positive or non-integer quantities', () => {
    expect(() => PricingEngine.calculatePricing(0)).toThrow();
    expect(() => PricingEngine.calculatePricing(-5)).toThrow();
    expect(() => PricingEngine.calculatePricing(12.5)).toThrow();
  });
});
