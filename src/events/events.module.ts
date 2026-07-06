import { Global, Module } from "@nestjs/common";
import { EventBusService } from "./event-bus.service";
import { OutboxDispatcherService } from "./outbox-dispatcher.service";
import { EventSubscriberRegistry } from "./event-subscriber-registry";
import { LoggingEventHandler } from "./logging-event.handler";
import { EventsController } from "./events.controller";

/**
 * The domain event bus (Phase 0). Global so any domain can inject
 * `EventBusService` to publish and `EventSubscriberRegistry` to subscribe.
 * Handlers self-register on module init — the events module never imports the
 * domains that consume events, keeping the backbone domain-agnostic.
 */
@Global()
@Module({
  controllers: [EventsController],
  providers: [
    EventBusService,
    OutboxDispatcherService,
    EventSubscriberRegistry,
    LoggingEventHandler,
  ],
  exports: [EventBusService, EventSubscriberRegistry],
})
export class EventsModule {}
