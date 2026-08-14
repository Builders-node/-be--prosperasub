import { Injectable, Logger } from "@nestjs/common";
import { GoogleCalendarService } from "./google-calendar.service";

export interface ProvisionResult {
  calendarId: string | null;
  created: boolean;
  shared: boolean;
  skipped?: string;
}

interface ProviderRow {
  id: string;
  name: string;
  contact_email: string | null;
  google_calendar_id: string | null;
  archetype_key: string | null;
}

/**
 * The platform owns every bookable calendar — a provider's and a court's.
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

  async provision(providerId: string): Promise<ProvisionResult> {
    const provider = await this.fetchProvider(providerId);
    if (!provider) throw new Error(`Provider ${providerId} not found`);
    const result = await this.provisionFor({
      table: "providers",
      id: providerId,
      existing: provider.google_calendar_id,
      summary: `EverySub — ${provider.name}`,
      description:
        `Bookings for ${provider.name} on EverySub.\n` +
        `Created and owned by the platform; events are written automatically.`,
      shareWith: provider.contact_email,
    });

    // A provider that already had visits has them on somebody else's calendar —
    // the shared one it was falling back to. Giving it a calendar is only half
    // the move; the visits have to follow, or the business it was sharing with
    // keeps showing work that is no longer theirs. Flagging the bookings is
    // enough: the sync evicts each event from the old calendar and recreates it
    // on the new one.
    if (result.created) await this.requeueBookings(providerId);
    return result;
  }

  /**
   * A court's calendar, on the same terms.
   *
   * Courts used to want a calendar id typed into an admin form, with a
   * separate manual step to grant our service account access — two chances to
   * get it wrong, and a booking that silently syncs nowhere when it is. Now the
   * platform creates the court's calendar exactly as it creates a provider's;
   * the club's own contact address gets write access so a human can still see
   * it.
   */
  async provisionCourt(courtId: string): Promise<ProvisionResult> {
    const courts = await this.restGet<Array<{ id: string; name: string; google_calendar_id: string | null }>>(
      `beach_club_courts?id=eq.${encodeURIComponent(courtId)}&select=id,name,google_calendar_id`,
    );
    const court = courts?.[0];
    if (!court) throw new Error(`Court ${courtId} not found`);

    // The club is one platform-owned provider; its contact address is the
    // nearest thing a court has to an owner.
    const club = await this.restGet<Array<{ contact_email: string | null }>>(
      `providers?source_service_key=eq.beach&select=contact_email&limit=1`,
    );

    return this.provisionFor({
      table: "beach_club_courts",
      id: courtId,
      existing: court.google_calendar_id,
      summary: `EverySub — ${court.name}`,
      description:
        `Bookings for the ${court.name} court on EverySub.\n` +
        `Created and owned by the platform; events are written automatically.`,
      shareWith: club?.[0]?.contact_email ?? null,
    });
  }

  /** The one provisioning routine. Idempotent by the `existing` check. */
  private async provisionFor(input: {
    table: "providers" | "beach_club_courts";
    id: string;
    existing: string | null | undefined;
    summary: string;
    description: string;
    shareWith: string | null | undefined;
  }): Promise<ProvisionResult> {
    if (input.existing?.trim()) {
      return { calendarId: input.existing.trim(), created: false, shared: false };
    }

    if (!this.google.isConfigured()) {
      // Not an error: a deployment without Google credentials should still be
      // able to approve providers and add courts. The calendar is provisioned
      // later, by the same call, once credentials exist.
      this.logger.warn(`[calendar] ${input.table}/${input.id}: Google Calendar not configured, skipping`);
      return { calendarId: null, created: false, shared: false, skipped: "google_not_configured" };
    }

    const { calendarId } = await this.google.createCalendar({
      summary: input.summary,
      description: input.description,
    });

    await this.writeCalendarId(input.table, input.id, calendarId);

    let shared = false;
    const email = input.shareWith?.trim();
    if (email) {
      try {
        await this.google.shareCalendar(calendarId, email, "writer");
        shared = true;
      } catch (err) {
        // The calendar exists and is already recorded; failing to share it is
        // worth a log and a retry, not an unwind that would strand the id.
        this.logger.warn(`[calendar] ${input.table}/${input.id}: share failed — ${String(err)}`);
      }
    }

    this.logger.log(`[calendar] ${input.table}/${input.id} → ${calendarId} (shared=${shared})`);
    return { calendarId, created: true, shared };
  }

  // ─── PostgREST ──────────────────────────────────────────────────────────────

  private restBase() {
    const url = process.env.SUPABASE_URL?.replace(/\/$/, "");
    const key = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_ANON_KEY;
    if (!url || !key) throw new Error("Supabase credentials are not configured");
    return { url, key };
  }

  private async restGet<T>(path: string): Promise<T | null> {
    const { url, key } = this.restBase();
    const res = await fetch(`${url}/rest/v1/${path}`, {
      headers: { apikey: key, Authorization: `Bearer ${key}` },
    });
    if (!res.ok) throw new Error(`Could not read ${path}: ${res.status}`);
    return (await res.json()) as T;
  }

  private async fetchProvider(providerId: string): Promise<ProviderRow | null> {
    const rows = await this.restGet<ProviderRow[]>(
      `providers?id=eq.${encodeURIComponent(providerId)}` +
      `&select=id,name,contact_email,google_calendar_id,archetype_key`,
    );
    return rows?.[0] ?? null;
  }

  /**
   * Mark this provider's already-synced visits as out of date, so the next sync
   * moves them onto the calendar it just got.
   *
   * Cleaning is the only service whose bookings carry Google events today, and
   * `cleaning_bookings.provider_id` holds the LEGACY provider id, not the
   * universal one — the id-space split that everything here has to respect.
   *
   * Best effort: the calendar is created and recorded either way, and a visit
   * that misses this requeue is picked up by any later edit or by a manual
   * "Sync all".
   */
  private async requeueBookings(providerId: string): Promise<void> {
    try {
      const rows = await this.restGet<Array<{ source_service_key: string | null; source_provider_id: string | null }>>(
        `providers?id=eq.${encodeURIComponent(providerId)}&select=source_service_key,source_provider_id`,
      );
      const row = rows?.[0];
      if (row?.source_service_key !== "cleaning" || !row.source_provider_id) return;

      const { url, key } = this.restBase();
      const res = await fetch(
        `${url}/rest/v1/cleaning_bookings` +
        `?provider_id=eq.${encodeURIComponent(row.source_provider_id)}` +
        `&google_calendar_event_id=not.is.null`,
        {
          method: "PATCH",
          headers: {
            apikey: key,
            Authorization: `Bearer ${key}`,
            "Content-Type": "application/json",
            Prefer: "return=minimal",
          },
          body: JSON.stringify({ google_calendar_sync_status: "pending" }),
        },
      );
      if (!res.ok) throw new Error(`${res.status} ${await res.text().catch(() => "")}`);
      this.logger.log(`[calendar] queued ${row.source_provider_id}'s visits to move to the new calendar`);
    } catch (err) {
      this.logger.warn(`[calendar] could not queue existing visits for ${providerId}: ${String(err)}`);
    }
  }

  private async writeCalendarId(table: string, rowId: string, calendarId: string) {
    const { url, key } = this.restBase();
    const res = await fetch(`${url}/rest/v1/${table}?id=eq.${encodeURIComponent(rowId)}`, {
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
      throw new Error(`Created calendar ${calendarId} but could not store it on ${table}: ${res.status}`);
    }
  }
}
