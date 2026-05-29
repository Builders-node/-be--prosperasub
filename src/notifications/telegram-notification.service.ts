import { Injectable } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { AdminPaymentNotificationPayload, NotificationSendResult } from "./notification.types";

@Injectable()
export class TelegramNotificationService {
  constructor(private readonly config: ConfigService) {}

  async sendAdminPaymentNotification(input: AdminPaymentNotificationPayload): Promise<NotificationSendResult> {
    const token = this.config.get<string>("TELEGRAM_BOT_TOKEN");
    const chatId = this.config.get<string>("TELEGRAM_ADMIN_CHAT_ID");

    if (!token || !chatId) {
      return {
        sent: false,
        provider: "telegram",
        reason: "missing_telegram_config"
      };
    }

    const response = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        chat_id: chatId,
        text: this.buildMessage(input),
        parse_mode: "HTML",
        disable_web_page_preview: true
      })
    });

    const body = await response.json().catch(() => null);
    if (!response.ok) {
      throw new Error(body?.description || `Telegram returned ${response.status}`);
    }

    return {
      sent: true,
      provider: "telegram",
      id: body?.result?.message_id ? String(body.result.message_id) : undefined
    };
  }

  private buildMessage(input: AdminPaymentNotificationPayload) {
    const lines = [
      "<b>New payment received</b>",
      "",
      `Service: ${this.escape(input.serviceName)}`,
      `Client: ${this.escape(input.clientName || "Not provided")}`,
      `Email: ${this.escape(input.clientEmail || "Not provided")}`,
      `Amount: ${this.escape(this.formatAmount(input))} ${this.escape(input.currency || "USD")}`,
      `Plan: ${this.escape(input.planName || "Not provided")}`,
      `Duration: ${this.escape(input.duration || "Not provided")}`,
      `Booking ID: ${this.escape(input.bookingId || "Not created yet")}`,
      `Payment ID: ${this.escape(input.providerPaymentId)}`,
      `Paid at: ${this.escape(this.formatDate(input.paidAt))}`
    ];

    if (input.adminUrl) {
      lines.push("", `Admin link: ${this.escape(input.adminUrl)}`);
    }

    return lines.join("\n");
  }

  private formatAmount(input: AdminPaymentNotificationPayload) {
    if (typeof input.amountCents === "number") return `$${(input.amountCents / 100).toFixed(2)}`;
    if (typeof input.amountSats === "number") return `${input.amountSats.toLocaleString("en-US")} sats`;
    return "Not provided";
  }

  private formatDate(value: AdminPaymentNotificationPayload["paidAt"]) {
    if (!value) return new Date().toISOString();
    return value instanceof Date ? value.toISOString() : value;
  }

  private escape(value: string) {
    return value
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;");
  }
}
