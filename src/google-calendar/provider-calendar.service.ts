import { Injectable, Logger } from "@nestjs/common";
import { GoogleCalendarService } from "./google-calendar.service";

interface ProviderRow {
  id: string;
  name: string;
  contact_email: string | null;
  google_calendar_id: string | null;
  archetype_key: string | null;
}

/**
 * The platform owns every provider's calendar.
 *
 * A provider signing up asked to be listed, not to run Google Workspace. Left
 * to them, the calendar behind a live booking flow is one they can rename,
 * unshare, or delete — and the failure is silent until a customer books into
 * nothing. So the platform creates it at approval, keeps the id on the
 * provider row, and grants the provider write access to it.
 *
 * Provisioning is idempotent: a provider that already has a calendar id keeps
 * it. Re-running is how an admin repairs a provider approved before this
 * existed, and how the approval flow can retry without making a second
 * calendar.
 */
@Injectable()
export class ProviderCalendarService {
  private readonly logger = new Logger(ProviderCalendarService.name);

  constructor(private readonly google: GoogleCalendarService) {}

  async provision(providerId: string): Promise<{
    calendarId: string | null;
    created: boolean;
    shared: boolean;
    skipped?: string;
  }> {
    const provider = await this.fetchProvider(providerId);
    if (!provider) throw new Error(`Provider ${providerId} not found`);

    if (provider.google_calendar_id?.trim()) {
      return { calendarId: provider.google_calendar_id.trim(), created: false, shared: false };
    }

    if (!this.google.isConfigured()) {
      // Not an error: a deployment without Google credentials should still be
      // able to approve providers. The calendar is provisioned later, by the
      // same call, once credentials exist.
      this.logger.warn(`[provider-calendar] ${providerId}: Google Calendar not configured, skipping`);
      return { calendarId: null, created: false, shared: false, skipped: "google_not_configured" };
    }

    const { calendarId } = await this.google.createCalendar({
      summary: `EverySub — ${provider.name}`,
      description:
        `Bookings for ${provider.name} on EverySub.\n` +
        `Created and owned by the platform; events are written automatically.`,
    });

    await this.writeCalendarId(providerId, calendarId);

    let shared = false;
    if (provider.contact_email?.trim()) {
      try {
        await this.google.shareCalendar(calendarId, provider.contact_email.trim(), "writer");
        shared = true;
      } catch (err) {
        // The calendar exists and is already recorded; failing to share it is
        // worth a log and a retry, not an unwind that would strand the id.
        this.logger.warn(`[provider-calendar] ${providerId}: share failed — ${String(err)}`);
      }
    }

    this.logger.log(`[provider-calendar] ${providerId} → ${calendarId} (shared=${shared})`);
    return { calendarId, created: true, shared };
  }

  // ─── PostgREST ──────────────────────────────────────────────────────────────

  private restBase() {
    const url = process.env.SUPABASE_URL?.replace(/\/$/, "");
    const key = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_ANON_KEY;
    if (!url || !key) throw new Error("Supabase credentials are not configured");
    return { url, key };
  }

  private async fetchProvider(providerId: string): Promise<ProviderRow | null> {
    const { url, key } = this.restBase();
    const res = await fetch(
      `${url}/rest/v1/providers?id=eq.${encodeURIComponent(providerId)}` +
      `&select=id,name,contact_email,google_calendar_id,archetype_key`,
      { headers: { apikey: key, Authorization: `Bearer ${key}` } },
    );
    if (!res.ok) throw new Error(`Could not read provider ${providerId}: ${res.status}`);
    const rows = (await res.json()) as ProviderRow[];
    return rows?.[0] ?? null;
  }

  private async writeCalendarId(providerId: string, calendarId: string) {
    const { url, key } = this.restBase();
    const res = await fetch(`${url}/rest/v1/providers?id=eq.${encodeURIComponent(providerId)}`, {
      method: "PATCH",
      headers: {
        apikey: key,
        Authorization: `Bearer ${key}`,
        "Content-Type": "application/json",
        Prefer: "return=minimal",
      },
      body: JSON.stringify({ google_calendar_id: calendarId }),
    });
    if (!res.ok) {
      throw new Error(`Created calendar ${calendarId} but could not store it: ${res.status}`);
    }
  }
}
