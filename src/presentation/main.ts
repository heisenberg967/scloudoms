import { PostgresClient } from '../infrastructure/db/PostgresClient.js';
import { PostgresOrderUnitOfWork } from '../infrastructure/db/PostgresOrderUnitOfWork.js';
import { SqlWarehouseRepository } from '../infrastructure/db/repositories/SqlWarehouseRepository.js';
import { SqlOrderRepository } from '../infrastructure/db/repositories/SqlOrderRepository.js';
import { SqlProductRepository } from '../infrastructure/db/repositories/SqlProductRepository.js';
import { SqlPricingRuleRepository } from '../infrastructure/db/repositories/SqlPricingRuleRepository.js';
import { OutboxDispatcher } from '../infrastructure/events/OutboxDispatcher.js';
import { ConsoleEventPublisher } from '../infrastructure/events/IEventPublisher.js';
import { QuoteOrderUseCase } from '../application/use-cases/QuoteOrderUseCase.js';
import { SubmitOrderUseCase } from '../application/use-cases/SubmitOrderUseCase.js';
import { GetOrderUseCase } from '../application/use-cases/GetOrderUseCase.js';
import { ListWarehousesUseCase } from '../application/use-cases/ListWarehousesUseCase.js';
import { buildApp } from './http/app.js';

async function bootstrap() {
  const production = process.env.NODE_ENV === 'production';
  const apiToken = process.env.API_TOKEN;
  if (production && (!apiToken || apiToken.length < 32))
    throw new Error('Production requires an API_TOKEN of at least 32 characters');
  const db = new PostgresClient();
  let app: Awaited<ReturnType<typeof buildApp>> | undefined;
  let outbox: OutboxDispatcher | undefined;
  try {
    await db.initializeSchema();
    const warehouses = new SqlWarehouseRepository(db);
    const orders = new SqlOrderRepository(db);
    const products = new SqlProductRepository(db);
    const rules = new SqlPricingRuleRepository(db);
    // Events remain pending unless a real publisher is wired in or local log mode is selected.
    if (!production && process.env.OUTBOX_LOG_EVENTS === 'true')
      outbox = new OutboxDispatcher(db, new ConsoleEventPublisher());
    app = await buildApp(
      {
        quoteOrderUseCase: new QuoteOrderUseCase(warehouses, products, rules),
        submitOrderUseCase: new SubmitOrderUseCase(new PostgresOrderUnitOfWork(db)),
        getOrderUseCase: new GetOrderUseCase(orders),
        listWarehousesUseCase: new ListWarehousesUseCase(warehouses),
        dbClient: db
      },
      { apiToken, logger: true }
    );
    let closing = false;
    const shutdown = async () => {
      if (closing) return;
      closing = true;
      try {
        await app!.close();
        await outbox?.stop();
        await db.close();
      } catch (error) {
        console.error('Shutdown failed', error);
        process.exitCode = 1;
      }
    };
    process.once('SIGINT', shutdown);
    process.once('SIGTERM', shutdown);
    await app.listen({
      port: Number(process.env.PORT ?? 3000),
      host: process.env.HOST ?? '0.0.0.0'
    });
    outbox?.start();
  } catch (error) {
    await app?.close();
    await outbox?.stop();
    await db.close();
    throw error;
  }
}
bootstrap().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
