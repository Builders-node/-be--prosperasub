import { Injectable, Logger, OnModuleInit } from "@nestjs/common";
import { EventSubscriberRegistry } from "../events/event-subscriber-registry";
import type { DomainEventEnvelope, DomainEventHandler } from "../events/domain-event";
import { MailService } from "../mail/mail.service";

const HN_TZ = "America/Tegucigalpa";
const enc = (v: string) => encodeURIComponent(v);
const isUuid = (v: unknown): v is string =>
  typeof v === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(v);

/**
 * Emails the provider's team when a court is booked (the booking engine's
 * `booking.BookingConfirmed`, which today is beach courts only). The team sees
 * date, time from–to, court, the customer's name and phone.
 *
 * A distinct subscriber from NotificationEventHandler (which only records an
 * intent): this one actually sends. Runs off the outbox, so a transient mail or
 * lookup failure is retried up to MAX_ATTEMPTS and then dead-lettered — it can't
 * wedge the queue. Missing, non-retryable data (no booking, no recipient)
 * returns quietly rather than throwing.
 */
@Injectable()
export class CourtBookingEmailHandler implements DomainEventHandler, OnModuleInit {
  readonly name = "court-booking-email";
  private readonly logger = new Logger(CourtBookingEmailHandler.name);

  constructor(
    private readonly registry: EventSubscriberRegistry,
    private readonly mail: MailService,
  ) {}

  onModuleInit(): void {
    this.registry.register(this);
  }

  handles(type: string): boolean {
    return type === "booking.BookingConfirmed";
  }

  async handle(event: DomainEventEnvelope): Promise<void> {
    const bookingId = String((event.payload as Record<string, unknown>)?.bookingId ?? "");
    if (!bookingId) return;

    const booking = (await this.rest<Array<Record<string, any>>>(
      `/bookings?id=eq.${enc(bookingId)}` +
      `&select=resource_id,subject_ref,start_at,end_at,label,provider_id,status&limit=1`,
    ))?.[0];
    if (!booking || !booking.start_at || !booking.end_at) return;

    const resource = booking.resource_id
      ? (await this.rest<Array<Record<string, any>>>(
          `/bookable_resources?id=eq.${enc(String(booking.resource_id))}&select=name,provider_id&limit=1`,
        ))?.[0]
      : null;
    const courtName = (resource?.name as string) || "Court";
    const providerId = (booking.provider_id as string) || (resource?.provider_id as string) || null;
    if (!providerId) return;

    const provider = (await this.rest<Array<Record<string, any>>>(
      `/providers?id=eq.${enc(providerId)}&select=name,contact_email,admin_user_id&limit=1`,
    ))?.[0];
    const recipients = await this.teamRecipients(
      providerId,
      provider?.contact_email as string | null,
      provider?.admin_user_id as string | null,
    );
    if (!recipients.length) {
      this.logger.warn(`no team recipient for provider ${providerId} — skipping court-booking email`);
      return;
    }

    // Customer name + phone. A `user:` subject is a real account (name from
    // users, phone from their beach membership); a `desk:` subject is a walk-in
    // the front desk named, so the label is all we have.
    let customerName = String(booking.label ?? "").trim() || "Guest";
    let phone = "";
    const userMatch = String(booking.subject_ref ?? "").match(/^user:(.+)$/);
    if (userMatch) {
      const uid = userMatch[1];
      const user = (await this.rest<Array<Record<string, any>>>(
        `/users?id=eq.${enc(uid)}&select=name,display_name,email&limit=1`,
      ))?.[0];
      customerName =
        String(user?.display_name || user?.name || booking.label || user?.email || "Guest").trim();
      const sub = (await this.rest<Array<Record<string, any>>>(
        `/provider_subscriptions?user_id=eq.${enc(uid)}&source_service_key=eq.beach` +
        `&customer_whatsapp=not.is.null&select=customer_whatsapp&order=created_at.desc&limit=1`,
      ))?.[0];
      phone = String(sub?.customer_whatsapp ?? "").trim();
    }

    const dateStr = this.fmtDate(booking.start_at);
    const fromStr = this.fmtTime(booking.start_at);
    const toStr = this.fmtTime(booking.end_at);

    const fields: Array<[string, string]> = [
      ["Date", dateStr],
      ["Time", `${fromStr} – ${toStr}`],
      ["Court", courtName],
      ["Name", customerName],
      ["Phone", phone || "—"],
    ];

    const text = `New court booking\n\n${fields.map(([k, v]) => `${k}: ${v}`).join("\n")}`;
    const html =
      `<h2 style="margin:0 0 12px">New court booking</h2>` +
      `<table style="border-collapse:collapse;font-family:Inter,Arial,sans-serif;font-size:14px">` +
      fields
        .map(
          ([k, v]) =>
            `<tr><td style="padding:4px 16px 4px 0;color:#7d7d7d">${k}</td>` +
            `<td style="padding:4px 0;font-weight:600;color:#2a2a2a">${escapeHtml(v)}</td></tr>`,
        )
        .join("") +
      `</table>`;

    const subject = `New booking · ${courtName} · ${dateStr} ${fromStr}`;
    for (const to of recipients) {
      await this.mail.sendMail({ to, subject, html, text });
    }
    this.logger.log(
      `court-booking email sent to ${recipients.length} recipient(s) for booking ${bookingId.slice(0, 8)}…`,
    );
  }

  /**
   * Who on the team hears about a booking. A configured `contact_email` is the
   * team inbox and wins outright; otherwise fall back to the people who run the
   * club — its owner and members — so the notice lands even when no inbox is set.
   * Member/owner ids are uuid-guarded before hitting the uuid `users.id` column.
   */
  private async teamRecipients(
    providerId: string,
    contactEmail: string | null,
    ownerId: string | null,
  ): Promise<string[]> {
    const contact = String(contactEmail ?? "").trim();
    if (contact) return [contact];

    const emails = new Set<string>();
    if (isUuid(ownerId)) {
      const owner = (await this.rest<Array<{ email: string | null }>>(
        `/users?id=eq.${enc(ownerId)}&select=email&limit=1`,
      ))?.[0];
      if (owner?.email) emails.add(owner.email.trim().toLowerCase());
    }

    const members = await this.rest<Array<{ user_id: string | null }>>(
      `/provider_members?provider_id=eq.${enc(providerId)}&select=user_id`,
    );
    const memberIds = [...new Set((members ?? []).map((m) => m.user_id).filter(isUuid))] as string[];
    if (memberIds.length) {
      const users = await this.rest<Array<{ email: string | null }>>(
        `/users?id=in.(${memberIds.map((id) => `"${id}"`).join(",")})&select=email`,
      );
      (users ?? []).forEach((u) => { if (u.email) emails.add(u.email.trim().toLowerCase()); });
    }
    return [...emails];
  }

  private fmtDate(iso: string): string {
    return new Intl.DateTimeFormat("en-US", {
      timeZone: HN_TZ, weekday: "short", month: "short", day: "numeric", year: "numeric",
    }).format(new Date(iso));
  }

  private fmtTime(iso: string): string {
    return new Intl.DateTimeFormat("en-US", {
      timeZone: HN_TZ, hour: "numeric", minute: "2-digit", hour12: true,
    }).format(new Date(iso));
  }

  private async rest<T>(path: string): Promise<T | null> {
    const base = process.env.SUPABASE_URL?.replace(/\/$/, "");
    const key = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_ANON_KEY;
    if (!base || !key) return null;
    const res = await fetch(`${base}/rest/v1${path}`, {
      headers: { apikey: key, Authorization: `Bearer ${key}` },
    });
    if (!res.ok) throw new Error(`Supabase ${res.status}: ${await res.text().catch(() => "")}`);
    return (await res.json()) as T;
  }
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c] as string));
}
