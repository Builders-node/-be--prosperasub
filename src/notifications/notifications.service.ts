import { Injectable, Logger } from "@nestjs/common";
import { PrismaService } from "../prisma/prisma.service";
import { EmailNotificationService } from "./email-notification.service";
import { AdminPaymentNotificationPayload } from "./notification.types";
import { TelegramNotificationService } from "./telegram-notification.service";

type CheckoutSessionInput = AdminPaymentNotificationPayload & {
  context?: string | null;
  description?: string | null;
  externalId?: string | null;
};

@Injectable()
export class NotificationsService {
  private readonly logger = new Logger(NotificationsService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly email: EmailNotificationService,
    private readonly telegram: TelegramNotificationService
  ) {}

  /** True when DB is reachable and notification deduplication tables are usable. */
  private get dbAvailable() {
    return this.prisma.isAvailable();
  }

  async recordCheckoutSession(input: CheckoutSessionInput) {
    if (!this.dbAvailable) {
      this.logger.warn(`[notifications] DB unavailable — checkout session ${input.provider}:${input.providerPaymentId} not persisted.`);
      return;
    }

    try {
      await this.prisma.paymentCheckoutSession.upsert({
        where: {
          provider_providerPaymentId: {
            provider: input.provider,
            providerPaymentId: input.providerPaymentId
          }
        },
        create: this.checkoutSessionData(input),
        update: this.checkoutSessionData(input)
      });
    } catch (error) {
      this.logger.warn(`Could not persist checkout session ${input.provider}:${input.providerPaymentId}: ${this.errorMessage(error)}`);
    }
  }

  async notifyPaymentSucceeded(input: AdminPaymentNotificationPayload, options: { force?: boolean } = {}) {
    const payload = this.normalizePayload(input);

    // When DB is unavailable, skip deduplication and fire notifications directly.
    if (!this.dbAvailable) {
      this.logger.warn(`[notifications] DB unavailable — sending ${payload.provider}:${payload.providerPaymentId} without deduplication.`);
      const emailResult = await this.sendEmailDirect(payload);
      const telegramResult = await this.sendTelegramDirect(payload);
      return { skipped: false, directSend: true, email: emailResult, telegram: telegramResult };
    }

    try {
      const existing = await this.prisma.adminPaymentNotification.findUnique({
        where: {
          provider_providerPaymentId: {
            provider: payload.provider,
            providerPaymentId: payload.providerPaymentId
          }
        }
      });

      if (existing && !options.force && existing.emailStatus === "sent" && existing.telegramStatus === "sent") {
        return {
          skipped: true,
          reason: "already_notified",
          notification: existing
        };
      }

      const notification = existing
        ? await this.prisma.adminPaymentNotification.update({
            where: { id: existing.id },
            data: this.notificationData(payload)
          })
        : await this.prisma.adminPaymentNotification.create({
            data: this.notificationData(payload)
          });

      const emailResult = await this.sendEmailIfNeeded(payload, notification, options.force);
      const telegramResult = await this.sendTelegramIfNeeded(payload, notification, options.force);

      const updated = await this.prisma.adminPaymentNotification.update({
        where: { id: notification.id },
        data: {
          ...emailResult,
          ...telegramResult
        }
      });

      return {
        skipped: false,
        notification: updated
      };
    } catch (error) {
      this.logger.error(`Admin payment notification failed for ${payload.provider}:${payload.providerPaymentId}: ${this.errorMessage(error)}`);
      return {
        skipped: false,
        error: this.errorMessage(error)
      };
    }
  }

  /**
   * @param overrides win over everything — what the caller knows for certain.
   * @param fallbacks are used only where neither the override nor the recorded
   *        checkout session has an answer: the payment rail's own idea of who
   *        paid, which is better than "Not provided" and worse than the
   *        platform's own record of whose subscription this is.
   */
  async notifyPaymentSucceededForProviderRef(
    provider: string,
    providerPaymentId: string,
    overrides: Partial<AdminPaymentNotificationPayload> = {},
    fallbacks: Partial<AdminPaymentNotificationPayload> = {},
  ) {
    let session: Awaited<ReturnType<typeof this.prisma.paymentCheckoutSession.findUnique>> | null = null;

    if (this.dbAvailable) {
      try {
        session = await this.prisma.paymentCheckoutSession.findUnique({
          where: {
            provider_providerPaymentId: {
              provider,
              providerPaymentId
            }
          }
        });
      } catch (error) {
        this.logger.warn(`Could not load checkout session ${provider}:${providerPaymentId}: ${this.errorMessage(error)}`);
      }
    }

    return this.notifyPaymentSucceeded({
      provider,
      providerPaymentId,
      serviceName: overrides.serviceName || session?.serviceName || fallbacks.serviceName || "EverySub payment",
      clientName: overrides.clientName ?? session?.clientName ?? fallbacks.clientName ?? null,
      clientEmail: overrides.clientEmail ?? session?.clientEmail ?? fallbacks.clientEmail ?? null,
      clientPhone: overrides.clientPhone ?? session?.clientPhone ?? fallbacks.clientPhone ?? null,
      amountCents: overrides.amountCents ?? session?.amountCents ?? null,
      amountSats: overrides.amountSats ?? session?.amountSats ?? null,
      currency: overrides.currency ?? session?.currency ?? "USD",
      planName: overrides.planName ?? session?.planName ?? null,
      duration: overrides.duration ?? session?.duration ?? null,
      bookingId: overrides.bookingId ?? session?.bookingId ?? null,
      adminUrl: overrides.adminUrl ?? session?.adminUrl ?? null,
      selectedDateTime: overrides.selectedDateTime ?? session?.selectedDateTime ?? null,
      paymentStatus: "paid",
      paidAt: overrides.paidAt ?? new Date()
    });
  }

  async listAdminPaymentNotifications() {
    if (!this.dbAvailable) return [];

    try {
      return await this.prisma.adminPaymentNotification.findMany({
        orderBy: { paidAt: "desc" },
        take: 50
      });
    } catch (error) {
      this.logger.warn(`Could not list admin payment notifications: ${this.errorMessage(error)}`);
      return [];
    }
  }

  async resendAdminPaymentNotification(id: string) {
    if (!this.dbAvailable) {
      return { error: "Database unavailable — cannot look up notification by ID." };
    }

    const notification = await this.prisma.adminPaymentNotification.findUnique({ where: { id } });
    if (!notification) {
      return { error: "Notification was not found." };
    }

    return this.notifyPaymentSucceeded(
      {
        provider: notification.provider,
        providerPaymentId: notification.providerPaymentId,
        serviceName: notification.serviceName,
        clientName: notification.clientName,
        clientEmail: notification.clientEmail,
        clientPhone: notification.clientPhone,
        amountCents: notification.amountCents,
        amountSats: notification.amountSats,
        currency: notification.currency,
        planName: notification.planName,
        duration: notification.duration,
        bookingId: notification.bookingId,
        adminUrl: notification.adminUrl,
        selectedDateTime: notification.selectedDateTime,
        paymentStatus: notification.paymentStatus,
        paidAt: notification.paidAt
      },
      { force: true }
    );
  }

  /** Send a test Telegram message directly to verify configuration. */
  async sendTelegramTest() {
    return this.telegram.sendAdminPaymentNotification({
      provider: "test",
      providerPaymentId: `test-${Date.now()}`,
      serviceName: "Prospera Backend — Test Notification",
      clientName: "Admin Test",
      clientEmail: "admin@prosperasub.com",
      amountCents: 4999,
      currency: "USD",
      planName: "Test Plan",
      duration: "1 month",
      paymentStatus: "paid",
      paidAt: new Date()
    });
  }

  /** Get recent Telegram bot updates (to find the admin chat_id). */
  async getTelegramBotUpdates() {
    const token = process.env.TELEGRAM_BOT_TOKEN;
    if (!token) {
      return { ok: false, error: "TELEGRAM_BOT_TOKEN is not set." };
    }

    try {
      const res = await fetch(`https://api.telegram.org/bot${token}/getUpdates`);
      const body = await res.json() as { ok: boolean; result?: Array<{ message?: { chat?: { id: number; first_name?: string; username?: string; type: string } } }> };
      if (!body.ok) return { ok: false, error: "Telegram API returned not-ok." };

      const chats = (body.result ?? [])
        .map((u) => u.message?.chat)
        .filter(Boolean)
        .filter((c, i, arr) => arr.findIndex((x) => x?.id === c?.id) === i);

      return { ok: true, chats };
    } catch (err) {
      return { ok: false, error: (err as Error).message };
    }
  }

  private async sendEmailIfNeeded(input: AdminPaymentNotificationPayload, existing: { emailStatus: string }, force?: boolean) {
    if (!force && existing.emailStatus === "sent") return {};

    try {
      const result = await this.email.sendAdminPaymentNotification(input);
      if (!result.sent) {
        return {
          emailStatus: "skipped",
          emailError: result.reason || null
        };
      }

      return {
        emailStatus: "sent",
        emailSentAt: new Date(),
        emailError: null
      };
    } catch (error) {
      return {
        emailStatus: "failed",
        emailError: this.errorMessage(error)
      };
    }
  }

  private async sendTelegramIfNeeded(input: AdminPaymentNotificationPayload, existing: { telegramStatus: string }, force?: boolean) {
    if (!force && existing.telegramStatus === "sent") return {};

    try {
      const result = await this.telegram.sendAdminPaymentNotification(input);
      if (!result.sent) {
        return {
          telegramStatus: "skipped",
          telegramError: result.reason || null
        };
      }

      return {
        telegramStatus: "sent",
        telegramSentAt: new Date(),
        telegramError: null
      };
    } catch (error) {
      return {
        telegramStatus: "failed",
        telegramError: this.errorMessage(error)
      };
    }
  }

  private async sendEmailDirect(input: AdminPaymentNotificationPayload) {
    try {
      return await this.email.sendAdminPaymentNotification(input);
    } catch (error) {
      this.logger.error(`Direct email send failed: ${this.errorMessage(error)}`);
      return { sent: false, provider: "email", reason: this.errorMessage(error) };
    }
  }

  private async sendTelegramDirect(input: AdminPaymentNotificationPayload) {
    try {
      return await this.telegram.sendAdminPaymentNotification(input);
    } catch (error) {
      this.logger.error(`Direct Telegram send failed: ${this.errorMessage(error)}`);
      return { sent: false, provider: "telegram", reason: this.errorMessage(error) };
    }
  }

  private normalizePayload(input: AdminPaymentNotificationPayload): Required<Pick<AdminPaymentNotificationPayload, "provider" | "providerPaymentId" | "serviceName">> & AdminPaymentNotificationPayload {
    return {
      ...input,
      serviceName: input.serviceName || "EverySub payment",
      currency: input.currency || "USD",
      paymentStatus: input.paymentStatus || "paid",
      paidAt: input.paidAt ? new Date(input.paidAt) : new Date()
    };
  }

  private checkoutSessionData(input: CheckoutSessionInput) {
    return {
      provider: input.provider,
      providerPaymentId: input.providerPaymentId,
      context: input.context ?? null,
      serviceName: input.serviceName || "EverySub payment",
      clientName: input.clientName ?? null,
      clientEmail: input.clientEmail ?? null,
      clientPhone: input.clientPhone ?? null,
      amountCents: input.amountCents ?? null,
      amountSats: input.amountSats ?? null,
      currency: input.currency || "USD",
      planName: input.planName ?? null,
      duration: input.duration ?? null,
      bookingId: input.bookingId ?? null,
      adminUrl: input.adminUrl ?? null,
      selectedDateTime: input.selectedDateTime ?? null,
      description: input.description ?? null,
      externalId: input.externalId ?? null
    };
  }

  private notificationData(input: AdminPaymentNotificationPayload) {
    return {
      provider: input.provider,
      providerPaymentId: input.providerPaymentId,
      serviceName: input.serviceName,
      clientName: input.clientName ?? null,
      clientEmail: input.clientEmail ?? null,
      clientPhone: input.clientPhone ?? null,
      amountCents: input.amountCents ?? null,
      amountSats: input.amountSats ?? null,
      currency: input.currency || "USD",
      planName: input.planName ?? null,
      duration: input.duration ?? null,
      bookingId: input.bookingId ?? null,
      adminUrl: input.adminUrl ?? null,
      selectedDateTime: input.selectedDateTime ?? null,
      paymentStatus: input.paymentStatus || "paid",
      paidAt: input.paidAt ? new Date(input.paidAt) : new Date()
    };
  }

  private errorMessage(error: unknown) {
    return error instanceof Error ? error.message : String(error);
  }
}
