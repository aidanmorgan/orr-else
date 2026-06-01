import { DomainEvents } from './DomainEvents.js';

export class Mediator {
  private readonly handlers: Map<string, Array<(data: unknown) => Promise<void>>> = new Map();

  constructor(private readonly domainEvents: DomainEvents) {}

  public on(event: string, handler: (data: unknown) => Promise<void>) {
    const list = this.handlers.get(event) ?? [];
    list.push(handler);
    this.handlers.set(event, list);
  }

  public async notify(event: string, data: unknown) {
    await this.domainEvents.emit(event, data);
    const eventHandlers = this.handlers.get(event) || [];
    await Promise.all(eventHandlers.map(handler => handler(data)));
  }
}
