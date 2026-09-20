import { SqlConnection } from './PostgresClient.js';
import {
  INITIAL_WAREHOUSES_SEED,
  INITIAL_PRODUCTS_SEED,
  INITIAL_PRICING_RULES_SEED
} from './seeds.js';

// Each entry is applied once, in the same transaction as its version record.
const migrations = [
  {
    version: 1,
    sql: `
      CREATE TABLE IF NOT EXISTS products (
        id TEXT PRIMARY KEY,
        sku TEXT UNIQUE NOT NULL,
        name TEXT NOT NULL,
        unit_price_cents INTEGER NOT NULL,
        unit_weight_grams INTEGER NOT NULL,
        unit_weight_kg DOUBLE PRECISION NOT NULL,
        created_at TIMESTAMPTZ DEFAULT NOW() NOT NULL
      );

      CREATE TABLE IF NOT EXISTS warehouses (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        latitude DOUBLE PRECISION NOT NULL,
        longitude DOUBLE PRECISION NOT NULL,
        stock INTEGER NOT NULL CHECK (stock >= 0),
        updated_at TIMESTAMPTZ DEFAULT NOW() NOT NULL
      );

      CREATE TABLE IF NOT EXISTS pricing_rules (
        id TEXT PRIMARY KEY,
        rule_name TEXT NOT NULL,
        shipping_rate_per_kg_km DOUBLE PRECISION NOT NULL,
        max_shipping_cost_ratio DOUBLE PRECISION NOT NULL,
        discount_tiers_json TEXT NOT NULL,
        is_active INTEGER DEFAULT 1 NOT NULL,
        created_at TIMESTAMPTZ DEFAULT NOW() NOT NULL
      );

      CREATE TABLE IF NOT EXISTS orders (
        id TEXT PRIMARY KEY,
        order_number TEXT UNIQUE NOT NULL,
        idempotency_key TEXT UNIQUE,
        pricing_rule_id TEXT,
        max_shipping_cost_ratio DOUBLE PRECISION NOT NULL DEFAULT 0.15,
        max_shipping_cost_cents INTEGER NOT NULL DEFAULT 0,
        sales_rep_id TEXT,
        quantity INTEGER NOT NULL,
        dest_latitude DOUBLE PRECISION NOT NULL,
        dest_longitude DOUBLE PRECISION NOT NULL,
        unit_price_cents INTEGER NOT NULL,
        gross_total_cents INTEGER NOT NULL,
        discount_tier TEXT NOT NULL,
        discount_percentage DOUBLE PRECISION NOT NULL,
        discount_amount_cents INTEGER NOT NULL,
        net_total_cents INTEGER NOT NULL,
        shipping_rate_per_kg_km DOUBLE PRECISION NOT NULL,
        total_weight_kg DOUBLE PRECISION NOT NULL,
        total_distance_km DOUBLE PRECISION NOT NULL,
        shipping_cost_cents INTEGER NOT NULL,
        shipping_cost_pct_of_net DOUBLE PRECISION NOT NULL,
        status TEXT NOT NULL,
        created_at TIMESTAMPTZ DEFAULT NOW() NOT NULL
      );

      CREATE TABLE IF NOT EXISTS order_allocations (
        id TEXT PRIMARY KEY,
        order_id TEXT NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
        warehouse_id TEXT NOT NULL REFERENCES warehouses(id),
        warehouse_name TEXT NOT NULL,
        warehouse_lat DOUBLE PRECISION NOT NULL,
        warehouse_lon DOUBLE PRECISION NOT NULL,
        quantity INTEGER NOT NULL,
        distance_km DOUBLE PRECISION NOT NULL,
        weight_kg DOUBLE PRECISION NOT NULL,
        shipping_cost_cents INTEGER NOT NULL
      );

      CREATE TABLE IF NOT EXISTS idempotency_keys (
        key TEXT PRIMARY KEY,
        request_hash TEXT,
        order_id TEXT NOT NULL,
        order_number TEXT NOT NULL,
        created_at TIMESTAMPTZ DEFAULT NOW() NOT NULL
      );

      CREATE TABLE IF NOT EXISTS inventory_audit_log (
        id TEXT PRIMARY KEY,
        warehouse_id TEXT NOT NULL REFERENCES warehouses(id),
        order_id TEXT REFERENCES orders(id),
        sales_rep_id TEXT,
        delta INTEGER NOT NULL,
        stock_after INTEGER NOT NULL,
        reason TEXT NOT NULL,
        created_at TIMESTAMPTZ DEFAULT NOW() NOT NULL
      );

      CREATE TABLE IF NOT EXISTS outbox_events (
        id TEXT PRIMARY KEY,
        event_type TEXT NOT NULL,
        aggregate_type TEXT NOT NULL,
        aggregate_id TEXT NOT NULL,
        payload TEXT NOT NULL,
        status TEXT DEFAULT 'PENDING' NOT NULL,
        attempts INTEGER NOT NULL DEFAULT 0,
        available_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        last_error TEXT,
        created_at TIMESTAMPTZ DEFAULT NOW() NOT NULL,
        published_at TIMESTAMPTZ
      );

      CREATE INDEX IF NOT EXISTS idx_orders_order_number ON orders(order_number);
      CREATE INDEX IF NOT EXISTS idx_orders_idempotency_key ON orders(idempotency_key);
      CREATE INDEX IF NOT EXISTS idx_orders_sales_rep_id ON orders(sales_rep_id);
      CREATE INDEX IF NOT EXISTS idx_order_allocations_order_id ON order_allocations(order_id);
      CREATE INDEX IF NOT EXISTS idx_inventory_audit_warehouse_id ON inventory_audit_log(warehouse_id);
      CREATE INDEX IF NOT EXISTS idx_idempotency_keys_order_id ON idempotency_keys(order_id);
      CREATE INDEX IF NOT EXISTS idx_outbox_events_status ON outbox_events(status);
    `
  },
  {
    version: 2,
    sql: `
    ALTER TABLE orders ADD COLUMN IF NOT EXISTS pricing_rule_id TEXT;
    ALTER TABLE orders ADD COLUMN IF NOT EXISTS max_shipping_cost_ratio DOUBLE PRECISION NOT NULL DEFAULT 0.15;
    ALTER TABLE orders ADD COLUMN IF NOT EXISTS max_shipping_cost_cents INTEGER NOT NULL DEFAULT 0;
    UPDATE orders SET max_shipping_cost_cents = round(net_total_cents * max_shipping_cost_ratio)
      WHERE max_shipping_cost_cents = 0;
    ALTER TABLE idempotency_keys ADD COLUMN IF NOT EXISTS request_hash TEXT;
    ALTER TABLE outbox_events ADD COLUMN IF NOT EXISTS attempts INTEGER NOT NULL DEFAULT 0;
    ALTER TABLE outbox_events ADD COLUMN IF NOT EXISTS available_at TIMESTAMPTZ NOT NULL DEFAULT NOW();
    ALTER TABLE outbox_events ADD COLUMN IF NOT EXISTS last_error TEXT;
    UPDATE outbox_events SET status = 'PENDING' WHERE status = 'FAILED';
    CREATE INDEX IF NOT EXISTS idx_outbox_available ON outbox_events (available_at, created_at) WHERE status = 'PENDING';
  `
  }
];

export async function migrate(connection: SqlConnection): Promise<void> {
  // Serializes startup migrations, including seeding, across application instances.
  await connection.query(
    'SELECT pg_advisory_xact_lock(hashtext(current_database() || current_schema()))'
  );
  await connection.query(
    'CREATE TABLE IF NOT EXISTS schema_migrations (version INTEGER PRIMARY KEY, applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW())'
  );
  for (const migration of migrations) {
    const exists = await connection.query(
      'SELECT version FROM schema_migrations WHERE version = $1',
      [migration.version]
    );
    if (exists.length) continue;
    await connection.query(migration.sql);
    if (migration.version === 1) {
      for (const w of INITIAL_WAREHOUSES_SEED) {
        await connection.query(
          `INSERT INTO warehouses (id, name, latitude, longitude, stock) VALUES ($1,$2,$3,$4,$5) ON CONFLICT DO NOTHING`,
          [w.id, w.name, w.latitude, w.longitude, w.stock]
        );
      }
      for (const p of INITIAL_PRODUCTS_SEED) {
        await connection.query(
          `INSERT INTO products (id,sku,name,unit_price_cents,unit_weight_grams,unit_weight_kg) VALUES ($1,$2,$3,$4,$5,$6) ON CONFLICT DO NOTHING`,
          [p.id, p.sku, p.name, p.unit_price_cents, p.unit_weight_grams, p.unit_weight_kg]
        );
      }
      for (const r of INITIAL_PRICING_RULES_SEED) {
        await connection.query(
          `INSERT INTO pricing_rules (id,rule_name,shipping_rate_per_kg_km,max_shipping_cost_ratio,discount_tiers_json,is_active) VALUES ($1,$2,$3,$4,$5,$6) ON CONFLICT DO NOTHING`,
          [
            r.id,
            r.rule_name,
            r.shipping_rate_per_kg_km,
            r.max_shipping_cost_ratio,
            r.discount_tiers_json,
            r.is_active
          ]
        );
      }
    }
    await connection.query('INSERT INTO schema_migrations (version) VALUES ($1)', [
      migration.version
    ]);
  }
}
