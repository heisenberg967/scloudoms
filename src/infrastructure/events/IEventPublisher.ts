export interface OutboxDomainEvent {
  readonly id: string;
  readonly eventType: string;
  readonly aggregateType: string;
  readonly aggregateId: string;
  readonly payload: any;
  readonly createdAt: Date;
}

export interface IEventPublisher {
  publish(event: OutboxDomainEvent): Promise<void>;
}

export class ConsoleEventPublisher implements IEventPublisher {
  public async publish(event: OutboxDomainEvent): Promise<void> {
    // In production, this would publish to an SNS/SQS, Kafka topic, or RabbitMQ exchange
    // Structured stdout event stream:
    const logLine = JSON.stringify({
      level: 'info',
      type: 'OUTBOX_DISPATCH',
      eventId: event.id,
      eventType: event.eventType,
      aggregateId: event.aggregateId,
      payload: event.payload,
      timestamp: new Date().toISOString()
    });
    process.stdout.write(`${logLine}\n`);
  }
}

