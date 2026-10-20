import { HttpError } from "./http.ts";

/** Port of MailService.sendMail (backend/src/mail) — Resend over plain fetch. */
export const APP_BRAND_NAME = "EverySub";
const DEFAULT_MAIL_FROM = `${APP_BRAND_NAME} <no-reply@prosperasub.com>`;

export interface MailMessage {
  to: string;
  subject: string;
  text: string;
  html: string;
}

export async function sendMail(message: MailMessage) {
  const apiKey = Deno.env.get("RESEND_API_KEY")?.trim();
  const from = Deno.env.get("MAIL_FROM")?.trim() || DEFAULT_MAIL_FROM;
  const replyTo = Deno.env.get("MAIL_REPLY_TO")?.trim();
  if (!apiKey) {
    console.warn(`Email not sent to ${message.to}: RESEND_API_KEY is not configured.`);
    return { sent: false, provider: "resend", reason: "missing_resend_api_key" };
  }
  const response = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      from,
      to: [message.to],
      subject: message.subject,
      html: message.html,
      text: message.text,
      ...(replyTo ? { reply_to: replyTo } : {}),
    }),
  });
  const body = (await response.json().catch(() => null)) as { id?: string; message?: string } | null;
  if (!response.ok) throw new HttpError(503, body?.message || "Email provider rejected the message.");
  return { sent: true, provider: "resend", id: body?.id ?? null };
}

export function escapeHtml(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}
