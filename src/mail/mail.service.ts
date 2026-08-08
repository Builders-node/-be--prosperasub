import { Injectable, Logger, ServiceUnavailableException } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { APP_BRAND_NAME, DEFAULT_MAIL_FROM } from "../config/branding";

interface MailMessage {
  to: string;
  subject: string;
  html: string;
  text: string;
}

interface PasswordResetEmailInput {
  to: string;
  resetUrl: string;
}

interface PaymentConfirmationEmailInput {
  to: string;
  customerName?: string;
  planName: string;
  monthlyPriceCents: number;
  totalCents: number;
  billingPeriodMonths: number;
  serviceStartDate: string;
  serviceEndDate: string;
  paidUntil: string;
  paymentReference?: string;
  apartmentNote?: string;
}

@Injectable()
export class MailService {
  private readonly logger = new Logger(MailService.name);

  constructor(private readonly config: ConfigService) {}

  async sendPasswordResetEmail(input: PasswordResetEmailInput) {
    return this.sendMail({
      to: input.to,
      subject: `Reset your ${APP_BRAND_NAME} password`,
      text: [
        `Reset your ${APP_BRAND_NAME} password`,
        "",
        "Use this secure link to choose a new password:",
        input.resetUrl,
        "",
        "This link expires in 30 minutes. If you did not request this email, you can ignore it."
      ].join("\n"),
      html: `
        <h1>Reset your ${APP_BRAND_NAME} password</h1>
        <p>Use this secure link to choose a new password:</p>
        <p><a href="${this.escapeAttribute(input.resetUrl)}">Reset password</a></p>
        <p>This link expires in 30 minutes. If you did not request this email, you can ignore it.</p>
      `
    });
  }

  async sendPaymentConfirmationEmail(input: PaymentConfirmationEmailInput) {
    const total = this.formatUsd(input.totalCents);
    const monthly = this.formatUsd(input.monthlyPriceCents);
    const subject = `Payment confirmed for ${input.planName}`;
    const apartmentLine = input.apartmentNote ? `Apartment / notes: ${input.apartmentNote}` : null;
    const referenceLine = input.paymentReference ? `Payment reference: ${input.paymentReference}` : null;

    const lines = [
      `Hi ${input.customerName?.trim() || "there"},`,
      "",
      "Your Lightning payment was confirmed.",
      "",
      `Plan: ${input.planName}`,
      `Monthly price: ${monthly}`,
      `Duration: ${input.billingPeriodMonths} month${input.billingPeriodMonths === 1 ? "" : "s"}`,
      `Total paid today: ${total}`,
      `Service period: ${input.serviceStartDate} - ${input.serviceEndDate}`,
      `Paid until: ${input.paidUntil}`,
      apartmentLine,
      referenceLine,
      "",
      "Next step: choose your recurring weekly cleaning schedule if you have not done it yet."
    ].filter(Boolean);

    return this.sendMail({
      to: input.to,
      subject,
      text: lines.join("\n"),
      html: `
        <h1>Payment confirmed</h1>
        <p>Hi ${this.escapeHtml(input.customerName?.trim() || "there")}, your Lightning payment was confirmed.</p>
        <table cellpadding="8" cellspacing="0" style="border-collapse:collapse">
          <tr><td><strong>Plan</strong></td><td>${this.escapeHtml(input.planName)}</td></tr>
          <tr><td><strong>Monthly price</strong></td><td>${monthly}</td></tr>
          <tr><td><strong>Duration</strong></td><td>${input.billingPeriodMonths} month${input.billingPeriodMonths === 1 ? "" : "s"}</td></tr>
          <tr><td><strong>Total paid today</strong></td><td>${total}</td></tr>
          <tr><td><strong>Service period</strong></td><td>${this.escapeHtml(input.serviceStartDate)} - ${this.escapeHtml(input.serviceEndDate)}</td></tr>
          <tr><td><strong>Paid until</strong></td><td>${this.escapeHtml(input.paidUntil)}</td></tr>
          ${input.apartmentNote ? `<tr><td><strong>Apartment / notes</strong></td><td>${this.escapeHtml(input.apartmentNote)}</td></tr>` : ""}
          ${input.paymentReference ? `<tr><td><strong>Payment reference</strong></td><td>${this.escapeHtml(input.paymentReference)}</td></tr>` : ""}
        </table>
        <p>Next step: choose your recurring weekly cleaning schedule if you have not done it yet.</p>
      `
    });
  }

  async sendMail(message: MailMessage) {
    const apiKey = this.config.get<string>("RESEND_API_KEY")?.trim();
    const from = this.config.get<string>("MAIL_FROM")?.trim() || DEFAULT_MAIL_FROM;
    const replyTo = this.config.get<string>("MAIL_REPLY_TO")?.trim();

    if (!apiKey) {
      this.logger.warn(`Email not sent to ${message.to}: RESEND_API_KEY is not configured.`);
      if (this.config.get<string>("NODE_ENV") !== "production") {
        this.logger.debug(`${message.subject}\n${message.text}`);
      }
      return { sent: false, provider: "resend", reason: "missing_resend_api_key" };
    }

    const response = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        from,
        to: [message.to],
        subject: message.subject,
        html: message.html,
        text: message.text,
        ...(replyTo ? { reply_to: replyTo } : {})
      })
    });

    const body = (await response.json().catch(() => null)) as { id?: string; message?: string } | null;

    if (!response.ok) {
      throw new ServiceUnavailableException(body?.message || "Email provider rejected the message.");
    }

    return { sent: true, provider: "resend", id: body?.id ?? null };
  }

  private formatUsd(cents: number) {
    return new Intl.NumberFormat("en-US", {
      style: "currency",
      currency: "USD"
    }).format(cents / 100);
  }

  private escapeHtml(value: string) {
    return value
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&#39;");
  }

  private escapeAttribute(value: string) {
    return this.escapeHtml(value);
  }
}
