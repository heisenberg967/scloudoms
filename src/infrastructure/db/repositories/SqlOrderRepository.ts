import { IOrderRepository } from '../../../domain/repositories/IOrderRepository.js';
import { Order, OrderStatus } from '../../../domain/models/Order.js';
import { Coordinates } from '../../../domain/models/Coordinates.js';
import { Money } from '../../../domain/models/Money.js';
import { Allocation } from '../../../domain/models/Allocation.js';
import { SqlConnection } from '../PostgresClient.js';

interface OrderRow {
  pricing_rule_id: string | null;
  max_shipping_cost_cents: number;
  max_shipping_cost_ratio: number;
  id: string;
  order_number: string;
  idempotency_key: string | null;
  sales_rep_id?: string | null;
  quantity: number;
  dest_latitude: number;
  dest_longitude: number;
  unit_price_cents: number;
  gross_total_cents: number;
  discount_tier: string;
  discount_percentage: number;
  discount_amount_cents: number;
  net_total_cents: number;
  shipping_rate_per_kg_km: number;
  total_weight_kg: number;
  total_distance_km: number;
  shipping_cost_cents: number;
  shipping_cost_pct_of_net: number;
  status: OrderStatus;
  created_at: string;
}

interface AllocationRow {
  id: string;
  order_id: string;
  warehouse_id: string;
  warehouse_name: string;
  warehouse_lat: number;
  warehouse_lon: number;
  quantity: number;
  distance_km: number;
  weight_kg: number;
  shipping_cost_cents: number;
}

export class SqlOrderRepository implements IOrderRepository {
  constructor(private readonly db: SqlConnection) {}

  // Call inside the order unit of work so allocations share the order transaction.
  async save(order: Order): Promise<void> {
    const data = {
      id: order.id,
      order_number: order.orderNumber,
      idempotency_key: order.idempotencyKey,
      sales_rep_id: order.salesRepId,
      pricing_rule_id: order.pricingRuleId,
      quantity: order.quantity,
      dest_latitude: order.shippingCoordinates.latitude,
      dest_longitude: order.shippingCoordinates.longitude,
      unit_price_cents: order.pricing.unitPrice.toCents(),
      gross_total_cents: order.pricing.grossTotal.toCents(),
      discount_tier: order.pricing.discountTier,
      discount_percentage: order.pricing.discountPercentage,
      discount_amount_cents: order.pricing.discountAmount.toCents(),
      net_total_cents: order.pricing.netTotal.toCents(),
      shipping_rate_per_kg_km: order.shipping.ratePerKgKm,
      total_weight_kg: order.shipping.totalWeightKg,
      total_distance_km: order.shipping.totalDistanceKm,
      shipping_cost_cents: order.shipping.totalShippingCost.toCents(),
      shipping_cost_pct_of_net: order.shipping.shippingCostPercentageOfNetTotal,
      max_shipping_cost_ratio: order.shipping.maxAllowedPercentage / 100,
      max_shipping_cost_cents: order.shipping.maxAllowedShippingCost.toCents(),
      status: order.status,
      created_at: order.createdAt
    };
    await this.db.query(
      `INSERT INTO orders (${Object.keys(data).join(',')}) VALUES (${Object.keys(data)
        .map((_, i) => '$' + (i + 1))
        .join(',')})`,
      Object.values(data)
    );
    for (const [i, a] of order.allocations.entries()) {
      await this.db.query(
        `INSERT INTO order_allocations (id,order_id,warehouse_id,warehouse_name,warehouse_lat,warehouse_lon,quantity,distance_km,weight_kg,shipping_cost_cents) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
        [
          order.id + '_alloc_' + i,
          order.id,
          a.warehouseId,
          a.warehouseName,
          a.warehouseCoordinates.latitude,
          a.warehouseCoordinates.longitude,
          a.quantity,
          a.distanceKm,
          a.weightKg,
          a.shippingCost.toCents()
        ]
      );
    }
  }
  async findByOrderNumber(value: string): Promise<Order | null> {
    return this.find('order_number', value);
  }
  async findById(value: string): Promise<Order | null> {
    return this.find('id', value);
  }
  private async find(
    column: 'id' | 'order_number',
    value: string
  ): Promise<Order | null> {
    const [row] = await this.db.query<OrderRow>(`SELECT * FROM orders WHERE ${column} = $1`, [
      value
    ]);
    return row ? this.hydrateOrder(row) : null;
  }
  private async hydrateOrder(row: OrderRow): Promise<Order> {
    const allocRows = await this.db.query<AllocationRow>(
      'SELECT * FROM order_allocations WHERE order_id = $1 ORDER BY id',
      [row.id]
    );
    const allocations = allocRows.map(
      (ar) =>
        new Allocation({
          warehouseId: ar.warehouse_id,
          warehouseName: ar.warehouse_name,
          warehouseCoordinates: Coordinates.create(ar.warehouse_lat, ar.warehouse_lon),
          distanceKm: ar.distance_km,
          quantity: ar.quantity,
          weightKg: ar.weight_kg,
          shippingCost: Money.fromCents(ar.shipping_cost_cents)
        })
    );

    const netTotal = Money.fromCents(row.net_total_cents);
    const maxAllowedShippingCost = Money.fromCents(row.max_shipping_cost_cents);

    return new Order({
      id: row.id,
      orderNumber: row.order_number,
      idempotencyKey: row.idempotency_key,
      salesRepId: row.sales_rep_id,
      pricingRuleId: row.pricing_rule_id,
      quantity: row.quantity,
      shippingCoordinates: Coordinates.create(row.dest_latitude, row.dest_longitude),
      pricing: {
        unitPrice: Money.fromCents(row.unit_price_cents),
        quantity: row.quantity,
        grossTotal: Money.fromCents(row.gross_total_cents),
        discountTier: row.discount_tier,
        discountPercentage: row.discount_percentage,
        discountAmount: Money.fromCents(row.discount_amount_cents),
        netTotal
      },
      shipping: {
        ratePerKgKm: row.shipping_rate_per_kg_km,
        totalWeightKg: row.total_weight_kg,
        totalDistanceKm: row.total_distance_km,
        totalShippingCost: Money.fromCents(row.shipping_cost_cents),
        shippingCostPercentageOfNetTotal: row.shipping_cost_pct_of_net,
        maxAllowedShippingCost,
        maxAllowedPercentage: row.max_shipping_cost_ratio * 100
      },
      allocations,
      status: row.status,
      createdAt: new Date(row.created_at)
    });
  }
}
