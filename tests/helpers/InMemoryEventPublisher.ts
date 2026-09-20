import { IEventPublisher, OutboxDomainEvent } from '../../src/infrastructure/events/IEventPublisher.js';

export class InMemoryEventPublisher implements IEventPublisher {
  public readonly publishedEvents: OutboxDomainEvent[] = [];

  public async publish(event: OutboxDomainEvent): Promise<void> {
    this.publishedEvents.push(event);
  }

}
