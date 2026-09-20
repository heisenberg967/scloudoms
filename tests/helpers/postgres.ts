import { randomUUID } from 'node:crypto';
import { PostgresClient } from '../../src/infrastructure/db/PostgresClient.js';
import { PostgresOrderUnitOfWork } from '../../src/infrastructure/db/PostgresOrderUnitOfWork.js';
import { SqlWarehouseRepository } from '../../src/infrastructure/db/repositories/SqlWarehouseRepository.js';
import { SqlOrderRepository } from '../../src/infrastructure/db/repositories/SqlOrderRepository.js';
import { SqlProductRepository } from '../../src/infrastructure/db/repositories/SqlProductRepository.js';
import { SqlPricingRuleRepository } from '../../src/infrastructure/db/repositories/SqlPricingRuleRepository.js';
import { QuoteOrderUseCase } from '../../src/application/use-cases/QuoteOrderUseCase.js';
import { SubmitOrderUseCase } from '../../src/application/use-cases/SubmitOrderUseCase.js';
import { GetOrderUseCase } from '../../src/application/use-cases/GetOrderUseCase.js';
import { ListWarehousesUseCase } from '../../src/application/use-cases/ListWarehousesUseCase.js';
import { buildApp } from '../../src/presentation/http/app.js';

export async function fixture(apiToken?: string) {
  const connectionString = process.env.TEST_DATABASE_URL;
  if (!connectionString)
    throw new Error(
      'TEST_DATABASE_URL is required for integration tests. See README; these tests never silently skip.'
    );
  const schema = 'test_' + randomUUID().replaceAll('-', '');
  const admin = new PostgresClient({ connectionString, maxConnections: 1 });
  const db = new PostgresClient({ connectionString, schema, maxConnections: 10 });
  try {
    await admin.query(`CREATE SCHEMA ${schema}`);
    await db.initializeSchema();
    const warehouses = new SqlWarehouseRepository(db);
    const orders = new SqlOrderRepository(db);
    const products = new SqlProductRepository(db);
    const rules = new SqlPricingRuleRepository(db);
    const submit = new SubmitOrderUseCase(new PostgresOrderUnitOfWork(db));
    const quote = new QuoteOrderUseCase(warehouses, products, rules);
    const get = new GetOrderUseCase(orders);
    const app = await buildApp(
      {
        quoteOrderUseCase: quote,
        submitOrderUseCase: submit,
        getOrderUseCase: get,
        listWarehousesUseCase: new ListWarehousesUseCase(warehouses),
        dbClient: db
      },
      { logger: false, apiToken }
    );
    await app.ready();
    return {
      db,
      app,
      submit,
      quote,
      get,
      orders,
      warehouses,
      rules,
      schema,
      connectionString,
      async close() {
        await app.close();
        await db.close();
        await admin.query(`DROP SCHEMA ${schema} CASCADE`);
        await admin.close();
      }
    };
  } catch (error) {
    await db.close();
    await admin.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`).catch(() => {});
    await admin.close();
    throw error;
  }
}
export type Fixture = Awaited<ReturnType<typeof fixture>>;
export const nearNY = {
  quantity: 30,
  customerCoordinates: { latitude: 40.7128, longitude: -74.006 }
};
