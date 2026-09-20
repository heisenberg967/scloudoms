import { randomUUID } from 'node:crypto';
import { IOrderUnitOfWork, OrderTransaction } from '../../application/ports/IOrderUnitOfWork.js';
import { IdempotencyConflictError, ServiceBusyError } from '../../domain/errors/DomainErrors.js';
import { PostgresClient } from './PostgresClient.js';
import { SqlWarehouseRepository } from './repositories/SqlWarehouseRepository.js';
import { SqlOrderRepository } from './repositories/SqlOrderRepository.js';
import { SqlProductRepository } from './repositories/SqlProductRepository.js';
import { SqlPricingRuleRepository } from './repositories/SqlPricingRuleRepository.js';

export class PostgresOrderUnitOfWork implements IOrderUnitOfWork {
  constructor(private readonly db: PostgresClient) {}
  async run<T>(work: (tx: OrderTransaction) => Promise<T>): Promise<T> {
    for (let attempt = 0; ; attempt++) {
      try {
        return await this.db.transaction(async (connection) => {
          await connection.query("SET LOCAL lock_timeout = '5s'");
          const orders = new SqlOrderRepository(connection);
          const warehouses = new SqlWarehouseRepository(connection);
          return work({
            orders,
            products: new SqlProductRepository(connection),
            pricingRules: new SqlPricingRuleRepository(connection),
            lockWarehouses: () => warehouses.lockAll(),
            claimIdempotency: async (key, hash, id, number) => {
              const inserted = await connection.query(
                `INSERT INTO idempotency_keys (key,request_hash,order_id,order_number) VALUES ($1,$2,$3,$4) ON CONFLICT (key) DO NOTHING RETURNING key`,
                [key, hash, id, number]
              );
              if (inserted.length) return null;
              const [prior] = await connection.query(
                'SELECT * FROM idempotency_keys WHERE key = $1',
                [key]
              );
              if (!prior || prior.request_hash !== hash) throw new IdempotencyConflictError();
              const order = await orders.findById(prior.order_id);
              if (!order) throw new Error('Idempotency record has no committed order');
              return order;
            },
            fulfill: async (order) => {
              for (const a of [...order.allocations].sort((a, b) =>
                a.warehouseId.localeCompare(b.warehouseId)
              )) {
                await warehouses.deductStock(a.warehouseId, a.quantity);
                const warehouse = await warehouses.findById(a.warehouseId);
                await connection.query(
                  `INSERT INTO inventory_audit_log (id,warehouse_id,order_id,sales_rep_id,delta,stock_after,reason) VALUES ($1,$2,$3,$4,$5,$6,$7)`,
                  [
                    randomUUID(),
                    a.warehouseId,
                    order.id,
                    order.salesRepId,
                    -a.quantity,
                    warehouse!.stock,
                    'Order fulfillment'
                  ]
                );
              }
              await connection.query(
                `INSERT INTO outbox_events (id,event_type,aggregate_type,aggregate_id,payload) VALUES ($1,'ORDER_SUBMITTED','Order',$2,$3)`,
                [
                  randomUUID(),
                  order.id,
                  JSON.stringify({
                    schemaVersion: 1,
                    ...order.toJSON(),
                    pricingRuleId: order.pricingRuleId
                  })
                ]
              );
            }
          });
        });
      } catch (error) {
        const code = (error as { code?: string }).code;
        if (!['40001', '40P01', '55P03'].includes(code ?? '')) throw error;
        if (attempt >= 2) throw new ServiceBusyError();
        await new Promise((resolve) => setTimeout(resolve, 20 * 2 ** attempt + Math.random() * 20));
      }
    }
  }
}
