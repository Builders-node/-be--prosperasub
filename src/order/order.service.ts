import { Injectable, Logger } from "@nestjs/common";
import type { Prisma } from "@prisma/client";
import { PrismaService } from "../prisma/prisma.service";
import { EventBusService } from "../events/event-bus.service";

export interface OrderLine {
  kind: string; // "booking" | "subscription" | …
  ref: string;
}

/**
 * Order domain — the transaction aggregate + the hub the saga drives. State
 * machine: draft → pending_payment → confirmed → completed / cancelled /
 * refunded. Placing an order records the fulfillment lines; when payment lands
 * the saga confirms it and emits `order.OrderConfirmed`, which Booking/Membership
 * react to. All transitions are idempotent (guarded by the current status).
 */
@Injectable()
export class OrderService {
  private readonly logger = new Logger(OrderService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly eventBus: EventBusService,
  ) {}

  async placeOrder(input: { subjectRef?: string; lines: OrderLine[]; amountCents?: number; currency?: string }) {
    const order = await this.prisma.order.create({
      data: {
        subjectRef: input.subjectRef ?? null,
        status: "pending_payment",
        amountCents: input.amountCents ?? null,
        currency: input.currency ?? "USD",
        lines: (input.lines ?? []) as unknown as Prisma.InputJsonValue,
      },
    });
    await this.eventBus.publish({
      type: "order.OrderPlaced",
      subjectRef: `order:${order.id}`,
      payload: { orderId: order.id, lines: input.lines ?? [], amountCents: input.amountCents ?? null },
    });
    return { orderId: order.id };
  }

  /** Payment landed → confirm. Idempotent: only a pending order transitions. */
  async confirm(orderId: string, paymentRef?: string): Promise<void> {
    const res = await this.prisma.order.updateMany({
      where: { id: orderId, status: "pending_payment" },
      data: { status: "confirmed", paymentRef: paymentRef ?? null },
    });
    if (res.count === 0) return;
    const order = await this.prisma.order.findUnique({ where: { id: orderId } });
    await this.eventBus.publish({
      type: "order.OrderConfirmed",
      subjectRef: `order:${orderId}`,
      payload: { orderId, lines: order?.lines ?? [], subjectRef: order?.subjectRef ?? null },
    });
  }

  async cancel(orderId: string, reason?: string): Promise<void> {
    const res = await this.prisma.order.updateMany({
      where: { id: orderId, status: { in: ["draft", "pending_payment", "confirmed"] } },
      data: { status: "cancelled" },
    });
    if (res.count === 0) return;
    await this.eventBus.publish({
      type: "order.OrderCancelled",
      subjectRef: `order:${orderId}`,
      payload: { orderId, reason: reason ?? null },
    });
  }

  async markRefunded(orderId: string): Promise<void> {
    const res = await this.prisma.order.updateMany({
      where: { id: orderId, status: { not: "refunded" } },
      data: { status: "refunded" },
    });
    if (res.count === 0) return;
    await this.eventBus.publish({
      type: "order.OrderRefunded",
      subjectRef: `order:${orderId}`,
      payload: { orderId },
    });
  }

  get(orderId: string) {
    return this.prisma.order.findUnique({ where: { id: orderId } });
  }
}
