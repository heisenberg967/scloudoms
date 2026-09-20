import { Coordinates } from './Coordinates.js';
import { Money } from './Money.js';
import { Allocation } from './Allocation.js';

export type OrderStatus = 'CONFIRMED' | 'FULFILLED' | 'CANCELLED';

export interface OrderPricing {
  unitPrice: Money;
  quantity: number;
  grossTotal: Money;
  discountTier: string;
  discountPercentage: number;
  discountAmount: Money;
  netTotal: Money;
}

export interface OrderShipping {
  ratePerKgKm: number;
  totalWeightKg: number;
  totalDistanceKm: number;
  totalShippingCost: Money;
  shippingCostPercentageOfNetTotal: number;
  maxAllowedShippingCost: Money;
  maxAllowedPercentage: number;
}

export interface OrderProps {
  id: string;
  orderNumber: string;
  idempotencyKey?: string | null;
  salesRepId?: string | null;
  pricingRuleId?: string | null;
  quantity: number;
  shippingCoordinates: Coordinates;
  pricing: OrderPricing;
  shipping: OrderShipping;
  allocations: Allocation[];
  status?: OrderStatus;
  createdAt?: Date;
}

export class Order {
  readonly id: string;
  readonly orderNumber: string;
  readonly idempotencyKey: string | null;
  readonly salesRepId: string | null;
  readonly pricingRuleId: string | null;
  readonly quantity: number;
  readonly shippingCoordinates: Coordinates;
  readonly pricing: OrderPricing;
  readonly shipping: OrderShipping;
  readonly allocations: readonly Allocation[];
  readonly status: OrderStatus;
  readonly createdAt: Date;

  constructor(props: OrderProps) {
    if (!props.id) throw new Error('Order id is required');
    if (!props.orderNumber) throw new Error('Order orderNumber is required');
    if (props.quantity <= 0) throw new Error('Order quantity must be positive');
    if (!props.allocations || props.allocations.length === 0) {
      throw new Error('Order must have at least one fulfillment allocation');
    }

    this.id = props.id;
    this.orderNumber = props.orderNumber;
    this.idempotencyKey = props.idempotencyKey ?? null;
    this.salesRepId = props.salesRepId ?? null;
    this.pricingRuleId = props.pricingRuleId ?? null;
    this.quantity = Math.floor(props.quantity);
    this.shippingCoordinates = props.shippingCoordinates;
    this.pricing = props.pricing;
    this.shipping = props.shipping;
    this.allocations = Object.freeze([...props.allocations]);
    this.status = props.status ?? 'CONFIRMED';
    this.createdAt = props.createdAt ?? new Date();
  }

  public toJSON() {
    return {
      id: this.id,
      orderNumber: this.orderNumber,
      idempotencyKey: this.idempotencyKey,
      salesRepId: this.salesRepId,
      quantity: this.quantity,
      shippingCoordinates: this.shippingCoordinates.toJSON(),
      status: this.status,
      createdAt: this.createdAt.toISOString(),
      pricing: {
        unitPrice: this.pricing.unitPrice.toDollars(),
        quantity: this.pricing.quantity,
        grossTotal: this.pricing.grossTotal.toDollars(),
        discountTier: this.pricing.discountTier,
        discountPercentage: this.pricing.discountPercentage,
        discountAmount: this.pricing.discountAmount.toDollars(),
        netTotal: this.pricing.netTotal.toDollars(),
        currency: 'USD'
      },
      shipping: {
        ratePerKgKm: this.shipping.ratePerKgKm,
        totalWeightKg: this.shipping.totalWeightKg,
        totalDistanceKm: this.shipping.totalDistanceKm,
        totalShippingCost: this.shipping.totalShippingCost.toDollars(),
        shippingCostPercentageOfNetTotal: this.shipping.shippingCostPercentageOfNetTotal,
        maxAllowedShippingCost: this.shipping.maxAllowedShippingCost.toDollars(),
        maxAllowedPercentage: this.shipping.maxAllowedPercentage
      },
      allocations: this.allocations.map((a) => a.toJSON())
    };
  }
}
