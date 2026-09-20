import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { fixture, Fixture, nearNY } from '../helpers/postgres.js';
import { PostgresClient } from '../../src/infrastructure/db/PostgresClient.js';
import { PostgresOrderUnitOfWork } from '../../src/infrastructure/db/PostgresOrderUnitOfWork.js';
import { SubmitOrderUseCase } from '../../src/application/use-cases/SubmitOrderUseCase.js';
import { OutboxDispatcher } from '../../src/infrastructure/events/OutboxDispatcher.js';
import { InMemoryEventPublisher } from '../helpers/InMemoryEventPublisher.js';

describe('PostgreSQL order API', () => {
  let f: Fixture;
  beforeEach(async () => {
    f = await fixture();
  });
  afterEach(async () => {
    await f?.close();
  });
  const counts = async (f: Fixture) =>
    Promise.all(
      [
        'orders',
        'idempotency_keys',
        'inventory_audit_log',
        'outbox_events',
        'order_allocations'
      ].map(
        async (table) => (await f.db.query(`SELECT count(*)::int AS count FROM ${table}`))[0].count
      )
    );

  it('commits an order, inventory, snapshot, audit and outbox together', async () => {
    const response = await f.app.inject({
      method: 'POST',
      url: '/v1/orders',
      payload: nearNY,
      headers: { 'x-sales-rep-id': 'rep-a' }
    });
    expect(response.statusCode, response.body).toBe(201);
    const order = response.json();
    expect(order.pricing.netTotal).toBe(4275);
    expect((await f.warehouses.findById('wh_ny'))!.stock).toBe(548);
    expect(await f.get.execute(order.orderNumber)).toEqual(order);
    expect(await counts(f)).toEqual([1, 0, 1, 1, 1]);
    expect((await f.db.query('SELECT * FROM inventory_audit_log'))[0]).toMatchObject({
      delta: -30,
      stock_after: 548,
      sales_rep_id: 'rep-a'
    });
    const event = JSON.parse((await f.db.query('SELECT payload FROM outbox_events'))[0].payload);
    expect(event).toMatchObject({
      schemaVersion: 1,
      orderNumber: order.orderNumber,
      pricingRuleId: 'rule_scos_p1_v1'
    });
  });

  it('quotes the specified product and discounts without reserving stock', async () => {
    const response = await f.app.inject({
      method: 'POST',
      url: '/v1/order-quotes',
      payload: nearNY
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      isValid: true,
      pricing: { unitPrice: 150, discountPercentage: 5, grossTotal: 4500, netTotal: 4275 },
      shipping: { ratePerKgKm: 0.01, totalWeightKg: 10.95 }
    });
    expect(await counts(f)).toEqual([0, 0, 0, 0, 0]);
    expect((await f.warehouses.findById('wh_ny'))!.stock).toBe(578);
    expect((await f.warehouses.findAll()).reduce((n, w) => n + w.stock, 0)).toBe(2556);
  });

  it('splits a submitted order across the cheapest warehouses', async () => {
    const order = await f.submit.execute({
      quantity: 400,
      customerCoordinates: { latitude: 34.0522, longitude: -118.2437 }
    });
    expect(order.allocations.map((a) => [a.warehouseId, a.quantity])).toEqual([
      ['wh_la', 355],
      ['wh_ny', 45]
    ]);
    expect((await f.warehouses.findById('wh_la'))!.stock).toBe(0);
    expect((await f.warehouses.findById('wh_ny'))!.stock).toBe(533);
    expect(await counts(f)).toEqual([1, 0, 2, 1, 2]);
  });

  it.each([0, -1, 1.5, 1000001])('rejects invalid quantity %s', async (quantity) => {
    const response = await f.app.inject({
      method: 'POST',
      url: '/v1/orders',
      payload: { ...nearNY, quantity }
    });
    expect(response.statusCode).toBe(400);
    expect(response.headers['content-type']).toContain('application/problem+json');
    expect(await counts(f)).toEqual([0, 0, 0, 0, 0]);
  });

  it('rejects malformed JSON as a client error', async () => {
    const response = await f.app.inject({
      method: 'POST',
      url: '/v1/orders',
      headers: { 'content-type': 'application/json' },
      payload: '{broken'
    });
    expect(response.statusCode).toBe(400);
    expect(response.json()).toMatchObject({ status: 400, title: 'Invalid Request' });
  });

  it('rejects invalid coordinates', async () => {
    const response = await f.app.inject({
      method: 'POST',
      url: '/v1/order-quotes',
      payload: { quantity: 1, customerCoordinates: { latitude: 91, longitude: 181 } }
    });
    expect(response.statusCode).toBe(400);
  });

  it('returns an invalid quote and a conflict for insufficient inventory', async () => {
    const input = { ...nearNY, quantity: 9999 };
    const quote = await f.quote.execute(input);
    expect(quote).toMatchObject({
      isValid: false,
      validationDetails: {
        status: 'INSUFFICIENT_STOCK',
        isStockAvailable: false,
        isShippingCostValid: false
      }
    });
    const response = await f.app.inject({
      method: 'POST',
      url: '/v1/orders',
      payload: input,
      headers: { 'idempotency-key': 'rejected' }
    });
    expect(response.statusCode).toBe(409);
    expect(await counts(f)).toEqual([0, 0, 0, 0, 0]);
  });

  it('rejects excessive shipping and rolls back the idempotency claim', async () => {
    const response = await f.app.inject({
      method: 'POST',
      url: '/v1/orders',
      payload: { quantity: 1, customerCoordinates: { latitude: -77.846, longitude: 166.676 } },
      headers: { 'idempotency-key': 'rejected' }
    });
    expect(response.statusCode).toBe(422);
    expect(await counts(f)).toEqual([0, 0, 0, 0, 0]);
    expect((await f.warehouses.findAll()).reduce((n, w) => n + w.stock, 0)).toBe(2556);
  });

  it('rolls back every write when audit persistence fails after the order write', async () => {
    await f.db.query(
      'ALTER TABLE inventory_audit_log ADD CONSTRAINT injected_failure CHECK (delta > 0)'
    );
    const response = await f.app.inject({
      method: 'POST',
      url: '/v1/orders',
      payload: nearNY,
      headers: { 'idempotency-key': 'failed-write' }
    });
    expect(response.statusCode).toBe(500);
    expect(await counts(f)).toEqual([0, 0, 0, 0, 0]);
    expect((await f.warehouses.findById('wh_ny'))!.stock).toBe(578);
  });

  it('replays an identical request without repeating writes and rejects changed payloads', async () => {
    const request = {
      method: 'POST' as const,
      url: '/v1/orders',
      payload: nearNY,
      headers: { 'idempotency-key': 'same' }
    };
    const first = await f.app.inject(request);
    const retry = await f.app.inject(request);
    expect(first.statusCode).toBe(201);
    expect(retry.statusCode).toBe(200);
    expect(retry.headers['idempotency-replayed']).toBe('true');
    expect(retry.json()).toEqual(first.json());
    const conflict = await f.app.inject({ ...request, payload: { ...nearNY, quantity: 40 } });
    expect(conflict.statusCode).toBe(409);
    expect(conflict.json().title).toBe('IDEMPOTENCY_CONFLICT');
    expect(await counts(f)).toEqual([1, 1, 1, 1, 1]);
    const metrics = (await f.app.inject('/metrics')).body;
    expect(metrics).toContain('oms_orders_submitted_total 1');
    expect(metrics).toContain('oms_duplicate_idempotency_requests_total 1');
  });

  it('rejects reusing a key with different sales-rep attribution', async () => {
    await f.submit.execute(nearNY, { idempotencyKey: 'same', salesRepId: 'a' });
    await expect(
      f.submit.execute(nearNY, { idempotencyKey: 'same', salesRepId: 'b' })
    ).rejects.toMatchObject({ code: 'IDEMPOTENCY_CONFLICT' });
  });

  it('preserves custom thresholds, prices and warehouse snapshots on reads and retries', async () => {
    await f.db.query(
      'UPDATE pricing_rules SET max_shipping_cost_ratio = 0.20, shipping_rate_per_kg_km = 0.02'
    );
    const { replayed, ...order } = await f.submit.execute(nearNY, { idempotencyKey: 'historic' });
    expect(order.shipping.maxAllowedPercentage).toBe(20);
    await f.db.query(
      'UPDATE pricing_rules SET max_shipping_cost_ratio = 0.10, shipping_rate_per_kg_km = 0.03'
    );
    await f.db.query('UPDATE products SET unit_price_cents = 20000');
    await f.db.query("UPDATE warehouses SET name = 'Renamed' WHERE id = 'wh_ny'");
    expect(await f.get.execute(order.orderNumber)).toEqual(order);
    expect(await f.submit.execute(nearNY, { idempotencyKey: 'historic' })).toEqual({
      ...order,
      replayed: true
    });
  });

  it('uses the database product weight in shipping calculations', async () => {
    const before = await f.quote.execute(nearNY);
    await f.db.query('UPDATE products SET unit_weight_grams = 730, unit_weight_kg = 0.730');
    const after = await f.quote.execute(nearNY);
    expect(after.shipping.totalWeightKg).toBe(before.shipping.totalWeightKg * 2);
    expect(after.shipping.totalShippingCost).toBeCloseTo(before.shipping.totalShippingCost * 2, 1);
  });

  it('applies changed discount tiers and rejects malformed configuration', async () => {
    await f.db.query('UPDATE pricing_rules SET discount_tiers_json = $1', [
      JSON.stringify([
        { minQuantity: 25, discountPercentage: 30, label: 'Promotion' },
        { minQuantity: 0, discountPercentage: 0, label: 'Standard' }
      ])
    ]);
    expect((await f.quote.execute(nearNY)).pricing.netTotal).toBe(3150);
    await f.db.query("UPDATE pricing_rules SET discount_tiers_json = 'broken'");
    await expect(f.quote.execute(nearNY)).rejects.toThrow();
  });

  it('fails clearly instead of silently applying hardcoded defaults when no pricing rule is active', async () => {
    await f.db.query('UPDATE pricing_rules SET is_active = 0');
    await expect(f.quote.execute(nearNY)).rejects.toMatchObject({
      code: 'PRICING_RULE_NOT_CONFIGURED'
    });
    await expect(f.submit.execute(nearNY)).rejects.toMatchObject({
      code: 'PRICING_RULE_NOT_CONFIGURED'
    });
  });

  it('rechecks stock at submission instead of treating a quote as a reservation', async () => {
    expect((await f.quote.execute(nearNY)).isValid).toBe(true);
    await f.db.query('UPDATE warehouses SET stock = 0');
    await expect(f.submit.execute(nearNY)).rejects.toMatchObject({ code: 'INSUFFICIENT_STOCK' });
  });

  it('prevents overselling across independent application connection pools', async () => {
    await f.db.query("UPDATE warehouses SET stock = CASE WHEN id = 'wh_ny' THEN 100 ELSE 0 END");
    const otherDb = new PostgresClient({
      connectionString: f.connectionString,
      schema: f.schema,
      maxConnections: 5
    });
    const other = new SubmitOrderUseCase(new PostgresOrderUnitOfWork(otherDb));
    try {
      const results = await Promise.allSettled(
        Array.from({ length: 8 }, (_, i) =>
          (i % 2 ? other : f.submit).execute(nearNY, { idempotencyKey: 'race-' + i })
        )
      );
      expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(3);
      expect(results.filter((r) => r.status === 'rejected')).toHaveLength(5);
      for (const r of results)
        if (r.status === 'rejected') expect(r.reason.code).toBe('INSUFFICIENT_STOCK');
      expect((await f.warehouses.findById('wh_ny'))!.stock).toBe(10);
      expect(await counts(f)).toEqual([3, 3, 3, 3, 3]);
    } finally {
      await otherDb.close();
    }
  });

  it('resolves simultaneous duplicate claims to one committed order', async () => {
    const results = await Promise.all(
      Array.from({ length: 8 }, () =>
        f.submit.execute(nearNY, { idempotencyKey: 'concurrent-duplicate' })
      )
    );
    expect(new Set(results.map((r) => r.orderNumber)).size).toBe(1);
    expect(results.filter((r) => !r.replayed)).toHaveLength(1);
    expect(await counts(f)).toEqual([1, 1, 1, 1, 1]);
    expect((await f.warehouses.findById('wh_ny'))!.stock).toBe(548);
  });

  it('handles opposing warehouse preferences concurrently without deadlocks', async () => {
    await f.db.query(
      "UPDATE warehouses SET stock = CASE WHEN id IN ('wh_ny','wh_la') THEN 100 ELSE 0 END"
    );
    const results = await Promise.all([
      f.submit.execute({
        quantity: 80,
        customerCoordinates: { latitude: 34.0522, longitude: -118.2437 }
      }),
      f.submit.execute({ ...nearNY, quantity: 80 })
    ]);
    expect(results.every((r) => r.status === 'CONFIRMED')).toBe(true);
    expect((await f.warehouses.findAll()).reduce((n, w) => n + w.stock, 0)).toBe(40);
  });

  it('publishes outbox payloads once during concurrent healthy drains', async () => {
    await f.submit.execute(nearNY);
    await f.submit.execute(nearNY);
    const publisher = new InMemoryEventPublisher();
    const a = new OutboxDispatcher(f.db, publisher),
      b = new OutboxDispatcher(f.db, publisher);
    const results = await Promise.all([a.dispatchPendingEvents(1), b.dispatchPendingEvents(1)]);
    expect(results.reduce((a, b) => a + b, 0)).toBe(2);
    expect(new Set(publisher.publishedEvents.map((e) => e.id)).size).toBe(2);
    expect(publisher.publishedEvents[0].payload.schemaVersion).toBe(1);
    expect(await a.dispatchPendingEvents()).toBe(0);
  });

  it('retries failed outbox delivery and preserves exhausted events for inspection', async () => {
    await f.submit.execute(nearNY);
    const failed = new OutboxDispatcher(f.db, {
      publish: async () => {
        throw new Error('unavailable');
      }
    });
    expect(await failed.dispatchPendingEvents()).toBe(0);
    expect((await f.db.query('SELECT * FROM outbox_events'))[0]).toMatchObject({
      status: 'PENDING',
      attempts: 1,
      last_error: 'unavailable'
    });
    expect(await failed.dispatchPendingEvents()).toBe(0);
    await f.db.query(
      "UPDATE outbox_events SET attempts=7, available_at=NOW() - INTERVAL '1 second'"
    );
    await failed.dispatchPendingEvents();
    expect((await f.db.query('SELECT * FROM outbox_events'))[0]).toMatchObject({
      status: 'DEAD',
      attempts: 8
    });
  });

  it('repeated and concurrent migrations do not reseed depleted inventory', async () => {
    await f.submit.execute(nearNY);
    await Promise.all([f.db.initializeSchema(), f.db.initializeSchema()]);
    expect((await f.warehouses.findById('wh_ny'))!.stock).toBe(548);
    expect(await f.db.query('SELECT * FROM schema_migrations')).toHaveLength(2);
  });

  it('documents real success and failure contracts', async () => {
    const spec = f.app.swagger() as any;
    const responses = spec.paths['/v1/orders'].post.responses;
    for (const code of [200, 201, 400, 401, 409, 422, 500, 503])
      expect(responses[String(code)]).toBeDefined();
    expect(responses['201'].content['application/json'].schema.properties.shipping).toBeDefined();
    expect((await f.app.inject('/docs/')).statusCode).toBe(200);
  });

  it('provides readiness, inventory metrics and missing-order errors', async () => {
    expect((await f.app.inject('/ready')).json().status).toBe('READY');
    expect((await f.app.inject('/v1/orders/missing')).statusCode).toBe(404);
    await f.db.query("UPDATE warehouses SET stock=10 WHERE id='wh_hk'");
    expect((await f.app.inject('/api/v1/alerts/stock')).json().hasLowStockAlerts).toBe(true);
    expect((await f.app.inject('/metrics')).body).toContain('oms_warehouse_stock_units');
  });
});

describe('Access control', () => {
  it('requires a configured token while leaving health probes accessible', async () => {
    const f = await fixture('a-test-token');
    try {
      expect((await f.app.inject('/api/v1/warehouses')).statusCode).toBe(401);
      expect(
        (
          await f.app.inject({
            url: '/api/v1/warehouses',
            headers: { authorization: 'Bearer wrong' }
          })
        ).statusCode
      ).toBe(401);
      expect(
        (
          await f.app.inject({
            url: '/api/v1/warehouses',
            headers: { authorization: 'Bearer a-test-token' }
          })
        ).statusCode
      ).toBe(200);
      expect((await f.app.inject('/health')).statusCode).toBe(200);
      expect((await f.app.inject('/ready')).statusCode).toBe(200);
    } finally {
      await f.close();
    }
  });
});
