import { Injectable, Logger, OnModuleInit } from "@nestjs/common";
import type { DomainEventEnvelope, DomainEventHandler } from "./domain-event";
import { EventSubscriberRegistry } from "./event-subscriber-registry";

/**
 * The first subscriber — logs every event. Proves the backbone end-to-end and
 * gives an audit trail while real consumers (Notification, Analytics, sagas)
 * are built out. Self-registers with the subscriber registry.
 */
@Injectable()
export class LoggingEventHandler implements DomainEventHandler, OnModuleInit {
  readonly name = "logging";
  private readonly logger = new Logger("DomainEvents");

  constructor(private readonly registry: EventSubscriberRegistry) {}

  onModuleInit(): void {
    this.registry.register(this);
  }

  handles(): boolean {
    return true;
  }

  async handle(event: DomainEventEnvelope): Promise<void> {
    this.logger.log(`${event.type} · ${event.subjectRef ?? "-"} · ${JSON.stringify(event.payload)}`);
  }
}
