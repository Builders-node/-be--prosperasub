import { OutboxDispatcherService } from "./outbox-dispatcher.service";
import { EventSubscriberRegistry } from "./event-subscriber-registry";
import type { DomainEventHandler } from "./domain-event";

/** In-memory stand-in for the Prisma calls the dispatcher makes. */
function makeFakePrisma() {
  const events: Array<{ id: string; type: string; version: number; occurredAt: Date; subjectRef: string | null; correlationId: string | null; causationId: string | null; payload: unknown; publishedAt: Date | null }> = [
    { id: "e1", type: "test.Boom", version: 1, occurredAt: new Date(), subjectRef: null, correlationId: null, causationId: null, payload: {}, publishedAt: null },
  ];
  const deliveries = new Map<string, { eventId: string; consumer: string; status: string; attempts: number; lastError: string | null }>();
  const key = (eventId: string, consumer: string) => `${eventId}|${consumer}`;
  return {
    events,
    deliveries,
    isAvailable: () => true,
    domainEvent: {
      findMany: async () => events.filter((e) => e.publishedAt === null),
      update: async ({ where, data }: any) => {
        const e = events.find((x) => x.id === where.id);
        if (e) e.publishedAt = data.publishedAt;
        return e;
      },
    },
    domainEventDelivery: {
      findUnique: async ({ where }: any) => deliveries.get(key(where.eventId_consumer.eventId, where.eventId_consumer.consumer)) ?? null,
      upsert: async ({ where, update, create }: any) => {
        const k = key(where.eventId_consumer.eventId, where.eventId_consumer.consumer);
        const existing = deliveries.get(k);
        const row = existing ? { ...existing, ...update } : { ...create };
        deliveries.set(k, row);
        return row;
      },
    },
  };
}

function registryWith(...handlers: DomainEventHandler[]): EventSubscriberRegistry {
  const reg = new EventSubscriberRegistry();
  handlers.forEach((h) => reg.register(h));
  return reg;
}

describe("OutboxDispatcherService dead-letter", () => {
  it("retries a failing handler then dead-letters it, unblocking the event", async () => {
    const prisma = makeFakePrisma();
    const boom: DomainEventHandler = {
      name: "boom",
      handles: () => true,
      handle: async () => { throw new Error("always fails"); },
    };
    const dispatcher = new OutboxDispatcherService(prisma as never, registryWith(boom));

    // Drains 1..4 — failing, retryable, event stays unpublished.
    for (let i = 1; i <= 4; i++) {
      const r = await dispatcher.drain();
      expect(r.failed).toBe(1);
      expect(r.deadLettered).toBe(0);
      expect(prisma.events[0].publishedAt).toBeNull();
      expect(prisma.deliveries.get("e1|boom")?.status).toBe("failed");
      expect(prisma.deliveries.get("e1|boom")?.attempts).toBe(i);
    }

    // Drain 5 — MAX_ATTEMPTS reached → dead-letter, event now published.
    const last = await dispatcher.drain();
    expect(last.deadLettered).toBe(1);
    expect(last.failed).toBe(0);
    expect(prisma.deliveries.get("e1|boom")?.status).toBe("dead");
    expect(prisma.events[0].publishedAt).not.toBeNull();

    // Subsequent drains find nothing (event published).
    const after = await dispatcher.drain();
    expect(after.processed).toBe(0);
  });

  it("a succeeding handler is not re-run and doesn't block", async () => {
    const prisma = makeFakePrisma();
    const handle = jest.fn().mockResolvedValue(undefined);
    const ok: DomainEventHandler = { name: "ok", handles: () => true, handle };
    const dispatcher = new OutboxDispatcherService(prisma as never, registryWith(ok));

    const r1 = await dispatcher.drain();
    expect(r1.delivered).toBe(1);
    expect(prisma.events[0].publishedAt).not.toBeNull();

    const r2 = await dispatcher.drain();
    expect(r2.processed).toBe(0);
    expect(handle).toHaveBeenCalledTimes(1);
  });
});
