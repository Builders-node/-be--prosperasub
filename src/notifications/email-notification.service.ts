import { Injectable } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { MailService } from "../mail/mail.service";
import { AdminPaymentNotificationPayload, NotificationSendResult } from "./notification.types";

@Injectable()
export class EmailNotificationService {
  constructor(
    private readonly config: ConfigService,
    private readonly mail: MailService
  ) {}

  sendAdminPaymentNotification(input: AdminPaymentNotificationPayload): Promise<NotificationSendResult> {
    const recipient = this.config.get<string>("ADMIN_PAYMENT_NOTIFICATION_EMAIL") || "edward.korytsky@gmail.com";
    return this.mail.sendMail({
      to: recipient,
      subject: `New payment received - ${input.serviceName}`,
      html: this.buildHtml(input),
      text: this.buildText(input)
    }) as Promise<NotificationSendResult>;
  }

  private buildHtml(input: AdminPaymentNotificationPayload) {
    const rows = this.buildRows(input)
      .map(([label, value]) => `<tr><td style="padding:8px 16px 8px 0;color:#6b7280;">${this.escape(label)}</td><td style="padding:8px 0;font-weight:700;">${this.escape(value)}</td></tr>`)
      .join("");

    const adminLink = input.adminUrl
      ? `<p style="margin-top:24px;"><a href="${this.escape(input.adminUrl)}" style="color:#f8a31a;font-weight:700;">Open admin record</a></p>`
      : "";

    return `
      <div style="font-family:Inter,Arial,sans-serif;color:#1f1f1f;line-height:1.5;">
        <h1 style="margin:0 0 8px;font-size:28px;">New payment received</h1>
        <p style="margin:0 0 24px;color:#6b7280;">A confirmed payment was received through ProsperaSub.</p>
        <table style="border-collapse:collapse;width:100%;max-width:680px;">${rows}</table>
        ${adminLink}
      </div>
    `;
  }

  private buildText(input: AdminPaymentNotificationPayload) {
    const lines = ["New payment received", "", ...this.buildRows(input).map(([label, value]) => `${label}: ${value}`)];
    if (input.adminUrl) lines.push("", `Admin link: ${input.adminUrl}`);
    return lines.join("\n");
  }

  private buildRows(input: AdminPaymentNotificationPayload): Array<[string, string]> {
    return [
      ["Product/service name", input.serviceName],
      ["Client name", input.clientName || "Not provided"],
      ["Client email", input.clientEmail || "Not provided"],
      ["Client phone", input.clientPhone || "Not provided"],
      ["Amount paid", this.formatAmount(input)],
      ["Currency", input.currency || "USD"],
      ["Payment provider", input.provider],
      ["Payment ID / transaction ID", input.providerPaymentId],
      ["Plan", input.planName || "Not provided"],
      ["Duration / months paid", input.duration || "Not provided"],
      ["Selected date/time", input.selectedDateTime || "Not selected yet"],
      ["Booking ID", input.bookingId || "Not created yet"],
      ["Payment status", input.paymentStatus || "paid"],
      ["Paid at", this.formatDate(input.paidAt)]
    ];
  }

  private formatAmount(input: AdminPaymentNotificationPayload) {
    if (typeof input.amountCents === "number") {
      return `$${(input.amountCents / 100).toFixed(2)}`;
    }
    if (typeof input.amountSats === "number") {
      return `${input.amountSats.toLocaleString("en-US")} sats`;
    }
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
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");
  }
}
