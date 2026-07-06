import { Injectable } from "@nestjs/common";
import type { DomainEventHandler } from "./domain-event";

/**
 * Holds the live set of event subscribers. Handlers self-register (on module
 * init) so any domain can subscribe to the bus without the events module
 * depending on it — keeping the event backbone domain-agnostic.
 */
@Injectable()
export class EventSubscriberRegistry {
  private readonly handlers: DomainEventHandler[] = [];

  register(handler: DomainEventHandler): void {
    if (!this.handlers.some((h) => h.name === handler.name)) {
      this.handlers.push(handler);
    }
  }

  all(): readonly DomainEventHandler[] {
    return this.handlers;
  }
}
