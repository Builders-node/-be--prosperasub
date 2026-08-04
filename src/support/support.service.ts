import { Injectable, Logger, ServiceUnavailableException } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { MailService } from "../mail/mail.service";

export interface SupportMessageInput {
  name: string;
  email: string;
  phone?: string | null;
  subject: string;
  message: string;
  page_url?: string | null;
  /** Set from the session when the sender is signed in. */
  user_id?: string | null;
}

/**
 * Inbound customer support.
 *
 * One message in, and that's it — the admin replies over email or WhatsApp.
 * There is no thread and no stored reply, so nothing in the product implies a
 * conversation the customer can come back to and find an answer in.
 *
 * The write goes through here rather than straight from the browser for two
 * reasons: the row carries contact details and so is service-role only, and
 * the notification email has to go out in the same operation — a support
 * message that lands in a table nobody is watching is worse than no form.
 */
@Injectable()
export class SupportService {
  private readonly logger = new Logger(SupportService.name);

  constructor(
    private readonly config: ConfigService,
    private readonly mail: MailService,
  ) {}

  private restBase(): { base: string; key: string } | null {
    const base = this.config.get<string>("SUPABASE_URL")?.replace(/\/$/, "");
    const key = this.config.get<string>("SUPABASE_SERVICE_ROLE_KEY");
    if (!base || !key) return null;
    return { base, key };
  }

  /** Where support mail lands. Falls back to the reply-to address. */
  private supportInbox(): string | null {
    return (
      this.config.get<string>("SUPPORT_INBOX_EMAIL")?.trim() ||
      this.config.get<string>("MAIL_REPLY_TO")?.trim() ||
      null
    );
  }

  async submit(input: SupportMessageInput) {
    const rest = this.restBase();
    if (!rest) throw new ServiceUnavailableException("Support is not configured.");

    const row = {
      user_id: input.user_id ?? null,
      name: input.name.trim(),
      email: input.email.trim().toLowerCase(),
      phone: input.phone?.trim() || null,
      subject: input.subject.trim(),
      message: input.message.trim(),
      page_url: input.page_url?.trim() || null,
      status: "new",
    };

    const res = await fetch(`${rest.base}/rest/v1/support_messages`, {
      method: "POST",
      headers: {
        apikey: rest.key,
        Authorization: `Bearer ${rest.key}`,
        "Content-Type": "application/json",
        Prefer: "return=representation",
      },
      body: JSON.stringify(row),
    });
    if (!res.ok) {
      const detail = await res.text().catch(() => "");
      this.logger.error(`Could not store support message: ${res.status} ${detail}`);
      throw new ServiceUnavailableException("Could not send your message. Please try again.");
    }
    const [saved] = (await res.json().catch(() => [])) as Array<{ id?: string }>;

    // Best-effort: the customer's message is already safely stored, so a mail
    // outage must not turn into "sending failed" and a re-submitted duplicate.
    const inbox = this.supportInbox();
    if (inbox) {
      try {
        await this.mail.sendMail({
          to: inbox,
          subject: `Support · ${row.subject}`,
          text: [
            `From: ${row.name} <${row.email}>`,
            row.phone ? `Phone: ${row.phone}` : null,
            row.page_url ? `Page: ${row.page_url}` : null,
            row.user_id ? `User id: ${row.user_id}` : "Not signed in",
            "",
            row.message,
          ].filter(Boolean).join("\n"),
          html: [
            `<p><strong>${escapeHtml(row.name)}</strong> &lt;${escapeHtml(row.email)}&gt;</p>`,
            row.phone ? `<p>Phone: ${escapeHtml(row.phone)}</p>` : "",
            row.page_url ? `<p>Page: ${escapeHtml(row.page_url)}</p>` : "",
            `<p>${row.user_id ? `User id: ${escapeHtml(row.user_id)}` : "Not signed in"}</p>`,
            `<hr /><p style="white-space:pre-wrap">${escapeHtml(row.message)}</p>`,
          ].join(""),
        });
      } catch (err) {
        this.logger.warn(`Support message ${saved?.id} stored but email failed: ${String(err)}`);
      }
    } else {
      this.logger.warn(
        `Support message ${saved?.id} stored but no inbox configured — set SUPPORT_INBOX_EMAIL.`,
      );
    }

      return { ok: true, id: saved?.id ?? null };
  }

  /**
   * Admin inbox. Read here rather than straight from the browser because the
   * table is service-role only — the rows carry a name, an email and whatever
   * the customer chose to write, so the anon key must not see them.
   */
  async list(status?: string) {
    const rest = this.restBase();
    if (!rest) throw new ServiceUnavailableException("Support is not configured.");
    const filter = status && status !== "all" ? `&status=eq.${encodeURIComponent(status)}` : "";
    const res = await fetch(
      `${rest.base}/rest/v1/support_messages?select=*${filter}&order=created_at.desc&limit=200`,
      { headers: { apikey: rest.key, Authorization: `Bearer ${rest.key}` } },
    );
    if (!res.ok) throw new ServiceUnavailableException("Could not load support messages.");
    return (await res.json()) as unknown[];
  }

  /** new ↔ handled. Not a ticket lifecycle — just "has someone dealt with it". */
  async setStatus(id: string, handled: boolean, adminUserId: string | null) {
    const rest = this.restBase();
    if (!rest) throw new ServiceUnavailableException("Support is not configured.");
    const res = await fetch(`${rest.base}/rest/v1/support_messages?id=eq.${encodeURIComponent(id)}`, {
      method: "PATCH",
      headers: {
        apikey: rest.key,
        Authorization: `Bearer ${rest.key}`,
        "Content-Type": "application/json",
        Prefer: "return=representation",
      },
      body: JSON.stringify({
        status: handled ? "handled" : "new",
        handled_at: handled ? new Date().toISOString() : null,
        handled_by: handled ? adminUserId : null,
      }),
    });
    if (!res.ok) throw new ServiceUnavailableException("Could not update the message.");
    const [row] = (await res.json().catch(() => [])) as unknown[];
    return row ?? { ok: true };
  }
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}
