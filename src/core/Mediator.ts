import { DomainEvents } from './DomainEvents.js';

export class Mediator {
  private readonly handlers: Map<string, Array<(data: any) => Promise<void>>> = new Map();

  constructor(private readonly domainEvents: DomainEvents) {}

  public on(event: string, handler: (data: any) => Promise<void>) {
    if (!this.handlers.has(event)) {
      this.handlers.set(event, []);
    }
    this.handlers.get(event)!.push(handler);
  }

  public async notify(event: string, data: any) {
    await this.domainEvents.emit(event, data);
    const eventHandlers = this.handlers.get(event) || [];
    await Promise.all(eventHandlers.map(handler => handler(data)));
  }
}
