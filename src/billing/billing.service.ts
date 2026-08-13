import { Injectable, Logger } from "@nestjs/common";
import type { Prisma } from "@prisma/client";
import { PrismaService } from "../prisma/prisma.service";
import { EventBusService } from "../events/event-bus.service";
import type { PaymentMethod } from "./payment-provider.port";

export interface RecordPaymentInput {
  method: PaymentMethod;
  providerRef: string;
  provider?: string;              // concrete gateway (blink / simplefi / paypal)
  amountCents?: number | null;
  currency?: string;
  subjectRef?: string | null;
  metadata?: Record<string, unknown>;
}

/**
 * The single place that records payments and emits billing events. Every rail
 * (lightning / on-chain / LIVES / PayPal / the reconcile cron) funnels through
 * here so "payment captured" has one definition and one event. Idempotent per
 * (provider, provider_ref): a repeated confirmation (polling) records + emits
 * only once.
 */
@Injectable()
export class BillingService {
  private readonly logger = new Logger(BillingService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly eventBus: EventBusService,
  ) {}

  async recordCaptured(input: RecordPaymentInput): Promise<void> {
    const provider = input.provider ?? input.method;
    const alreadyCaptured = await this.persistCaptured(provider, input);
    if (alreadyCaptured) return; // idempotent — event already emitted for this payment

    await this.eventBus.publish({
      type: "billing.PaymentCaptured",
      subjectRef: input.subjectRef ?? `payment:${input.providerRef}`,
      payload: {
        method: input.method,
        provider,
        providerRef: input.providerRef,
        amountCents: input.amountCents ?? null,
        currency: input.currency ?? "USD",
      },
    });
  }

  /**
   * What this payment was worth, taken from the checkout session the server
   * itself wrote when it created the invoice.
   *
   * Three of the four rails call `recordCaptured` without an amount — the
   * status endpoints only receive a payment hash — so every ledger row was
   * landing with `amount_cents = NULL`. Twelve rows, none of them with a
   * figure, against $4,060 of paid subscriptions: a ledger that knows a
   * payment happened but not for how much cannot pay anyone out.
   *
   * The session is the right source rather than the request body: it is
   * written server-side at invoice time and keyed uniquely on
   * (provider, provider_payment_id), so the number cannot be talked up by
   * whoever is calling the status endpoint.
   */
  private async amountFromSession(provider: string, providerRef: string) {
    try {
      const session = await this.prisma.paymentCheckoutSession.findUnique({
        where: { provider_providerPaymentId: { provider, providerPaymentId: providerRef } },
      });
      if (!session) return null;
      return {
        amountCents: session.amountCents ?? null,
        currency: session.currency ?? "USD",
        subjectRef: session.bookingId ? `booking:${session.bookingId}` : null,
        context: session.context ?? null,
      };
    } catch {
      return null;
    }
  }

  /** @returns true if this payment was already captured (so the event is skipped). */
  private async persistCaptured(provider: string, input: RecordPaymentInput): Promise<boolean> {
    if (!this.prisma.isAvailable()) return false;
    try {
      const existing = await this.prisma.payment.findFirst({
        where: { provider, providerRef: input.providerRef },
      });
      if (existing?.status === "captured") return true;

      const fallback = input.amountCents == null || input.subjectRef == null
        ? await this.amountFromSession(provider, input.providerRef)
        : null;

      const data = {
        method: input.method,
        provider,
        providerRef: input.providerRef,
        amountCents: input.amountCents ?? fallback?.amountCents ?? null,
        currency: input.currency ?? fallback?.currency ?? "USD",
        status: "captured",
        subjectRef: input.subjectRef ?? fallback?.subjectRef ?? null,
        metadata: {
          ...(fallback?.context ? { context: fallback.context } : {}),
          ...(input.metadata ?? {}),
        } as Prisma.InputJsonValue,
        paidAt: new Date(),
      };
      if (existing) {
        await this.prisma.payment.update({ where: { id: existing.id }, data });
      } else {
        await this.prisma.payment.create({ data });
      }
      return false;
    } catch (err) {
      // Best-effort in Phase 1 — never block the payment flow. Still emit.
      this.logger.error(
        `Failed to persist payment ${provider}:${input.providerRef}: ${err instanceof Error ? err.message : String(err)}`,
      );
      return false;
    }
  }
}
