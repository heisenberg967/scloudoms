import { PostgresClient } from '../db/PostgresClient.js';
import { IEventPublisher } from './IEventPublisher.js';

export class OutboxDispatcher {
  private timer?: NodeJS.Timeout;
  private inFlight?: Promise<number>;
  constructor(
    private readonly db: PostgresClient,
    private readonly publisher: IEventPublisher
  ) {}

  dispatchPendingEvents(batchSize = 20): Promise<number> {
    if (this.inFlight) return this.inFlight;
    this.inFlight = this.dispatch(batchSize).finally(() => {
      this.inFlight = undefined;
    });
    return this.inFlight;
  }
  private async dispatch(batchSize: number): Promise<number> {
    return this.db.transaction(async (tx) => {
      const rows = await tx.query(
        `SELECT * FROM outbox_events WHERE status = 'PENDING' AND available_at <= NOW()
        ORDER BY created_at, id LIMIT $1 FOR UPDATE SKIP LOCKED`,
        [batchSize]
      );
      let published = 0;
      for (const row of rows) {
        try {
          await this.publisher.publish({
            id: row.id,
            eventType: row.event_type,
            aggregateType: row.aggregate_type,
            aggregateId: row.aggregate_id,
            payload: JSON.parse(row.payload),
            createdAt: new Date(row.created_at)
          });
        } catch (error) {
          await tx.query(
            `UPDATE outbox_events SET attempts = attempts + 1,
            status = CASE WHEN attempts + 1 >= 8 THEN 'DEAD' ELSE 'PENDING' END,
            available_at = NOW() + (LEAST(300, power(2, attempts + 1)) * INTERVAL '1 second'), last_error = $2 WHERE id = $1`,
            [row.id, error instanceof Error ? error.message.slice(0, 500) : 'Publisher failed']
          );
          continue;
        }
        await tx.query(
          "UPDATE outbox_events SET status = 'PUBLISHED', published_at = NOW(), attempts = attempts + 1, last_error = NULL WHERE id = $1",
          [row.id]
        );
        published++;
      }
      return published;
    });
  }
  start(intervalMs = 2000): void {
    if (this.timer) return;
    this.timer = setInterval(() => {
      void this.dispatchPendingEvents().catch((error) =>
        console.error('Outbox dispatch failed', error)
      );
    }, intervalMs);
    this.timer.unref();
  }
  async stop(): Promise<void> {
    clearInterval(this.timer);
    this.timer = undefined;
    await this.inFlight;
  }
}
