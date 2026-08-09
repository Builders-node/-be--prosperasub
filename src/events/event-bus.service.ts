import { Injectable, Logger } from "@nestjs/common";
import type { Prisma } from "@prisma/client";
import { PrismaService } from "../prisma/prisma.service";
import { OutboxDispatcherService } from "./outbox-dispatcher.service";
import type { PublishInput } from "./domain-event";

/**
 * Appends domain events to the transactional outbox (`domain_events`). Other
 * domains inject this and call `publish` when state changes; the outbox
 * dispatcher delivers them to subscribers.
 *
 * Phase 0: best-effort (a failed publish never breaks the business action). As
 * domains are extracted, `publish` moves into the same DB transaction as the
 * state change for true atomicity.
 */
@Injectable()
export class EventBusService {
  private readonly logger = new Logger(EventBusService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly dispatcher: OutboxDispatcherService,
  ) {}

  async publish(input: PublishInput): Promise<void> {
    if (!this.prisma.isAvailable()) {
      this.logger.warn(`Skipped publish '${input.type}' — database unavailable.`);
      return;
    }
    try {
      await this.prisma.domainEvent.create({
        data: {
          type: input.type,
          version: input.version ?? 1,
          subjectRef: input.subjectRef ?? null,
          correlationId: input.correlationId ?? null,
          causationId: input.causationId ?? null,
          payload: (input.payload ?? {}) as Prisma.InputJsonValue,
        },
      });
    } catch (err) {
      this.logger.error(`Failed to publish '${input.type}': ${err instanceof Error ? err.message : String(err)}`);
      return;
    }

    // Deliver now, don't wait for the cron.
    //
    // The outbox was drained only by `/cron/dispatch-events`, which runs once a
    // day at 06:30. Every subscriber therefore learned about an event up to 24
    // hours late — for a court reservation mirrored into the operator's CRM
    // that means they hear about it the next morning, quite possibly after the
    // booking has already happened.
    //
    // Fire-and-forget and never rethrow: the business action that published this
    // has already committed, and the row stays in the outbox with its retry
    // count, so the cron remains the safety net if this pass fails.
    void this.dispatcher.drain(25).catch((err) => {
      this.logger.warn(`Inline dispatch after '${input.type}' failed: ${err instanceof Error ? err.message : String(err)}`);
    });
  }
}
