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
   * A bookable calendar's Google calendar, on the same terms as a provider's.
   *
   * This was `provisionCourt` and took a `beach_club_courts` id, so only the
   * beach could ever have one. It takes a `bookable_resources` id now — a
   * room, a table or a chair gets its calendar the same way — and the id is
   * stored on the resource's own metadata rather than on a legacy column.
   */
  async provisionResource(resourceId: string): Promise<ProvisionResult> {
    const rows = await this.restGet<Array<{
      id: string; name: string; provider_id: string; metadata: Record<string, unknown> | null;
    }>>(
      `bookable_resources?id=eq.${encodeURIComponent(resourceId)}&select=id,name,provider_id,metadata`,
    );
    const resource = rows?.[0];
    if (!resource) throw new Error(`Calendar ${resourceId} not found`);

    // The business that owns the calendar is who the calendar is shared with.
    const owner = await this.restGet<Array<{ contact_email: string | null }>>(
      `providers?id=eq.${encodeURIComponent(resource.provider_id)}&select=contact_email&limit=1`,
    );

    return this.provisionFor({
      table: "bookable_resources",
      id: resourceId,
      existing: (resource.metadata?.google_calendar_id as string | null) ?? null,
      summary: `EverySub — ${resource.name}`,
      description:
        `Bookings for ${resource.name} on EverySub.\n` +
        `Created and owned by the platform; events are written automatically.`,
      shareWith: owner?.[0]?.contact_email ?? null,
    });
  }

  /** The one provisioning routine. Idempotent by the `existing` check. */
  private async provisionFor(input: {
    table: "providers" | "bookable_resources";
    id: string;
    existing: string | null | undefined;
    summary: string;
    description: string;
    shareWith: string | null | undefined;
  }): Promise<ProvisionResult> {
    // Already has one — but "already has one" is not the same as "someone can
    // see it". A provider approved without a contact email got a calendar owned
    // solely by the service account, and because this returned here, pressing
    // the button again could never fix that: the calendar existed, so nothing
    // happened, for ever. Re-running now shares it with whatever address the
    // provider has since been given.
    if (input.existing?.trim()) {
      const calendarId = input.existing.trim();
      if (!this.google.isConfigured()) return { calendarId, created: false, shared: false };
      const shared = await this.shareWithAll(calendarId, input.shareWith, `${input.table}/${input.id}`);
      return { calendarId, created: false, shared };
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

    const shared = await this.shareWithAll(calendarId, input.shareWith, `${input.table}/${input.id}`);

    this.logger.log(`[calendar] ${input.table}/${input.id} → ${calendarId} (shared=${shared})`);
    return { calendarId, created: true, shared };
  }

  /**
   * Everyone who should be able to open this calendar.
   *
   * The provider's own address, when it has one — and always the platform
   * owner's, from `global_settings.calendar_owner_email`. Without the second,
   * a provider with no contact email gets a calendar that only the service
   * account can see: real bookings landing where no human has a link. Both
   * cleaning providers were in exactly that state.
   *
   * Best effort per address: the calendar exists and is already recorded, so a
   * failed share is worth a log and a retry, not an unwind that would strand
   * the id.
   */
  private async shareWithAll(
    calendarId: string,
    providerEmail: string | null | undefined,
    label: string,
  ): Promise<boolean> {
    const owner = await this.ownerEmail();
    const audience = [providerEmail?.trim(), owner].filter(
      (e): e is string => !!e && e.includes("@"),
    );
    const unique = [...new Set(audience.map((e) => e.toLowerCase()))];

    let anyShared = false;
    for (const email of unique) {
      try {
        await this.google.shareCalendar(calendarId, email, "writer");
        anyShared = true;
      } catch (err) {
        this.logger.warn(`[calendar] ${label}: share with ${email} failed — ${String(err)}`);
      }
    }
    return anyShared;
  }

  /** The platform owner's address, or null when nobody has set one. */
  private async ownerEmail(): Promise<string | null> {
    try {
      const rows = await this.restGet<Array<{ value: unknown }>>(
        `global_settings?key=eq.calendar_owner_email&select=value`,
      );
      const raw = rows?.[0]?.value;
      const email = typeof raw === "string" ? raw : null;
      return email && email.includes("@") ? email : null;
    } catch (err) {
      this.logger.warn(`[calendar] could not read calendar_owner_email: ${String(err)}`);
      return null;
    }
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

  /**
   * Where the calendar id lives depends on what owns it: a provider has a
   * column, a bookable calendar keeps it in `metadata` beside its iCal token.
   * Merging rather than replacing that object, because the token is in there.
   */
  private async writeCalendarId(table: string, rowId: string, calendarId: string) {
    const { url, key } = this.restBase();

    let body: Record<string, unknown> = { google_calendar_id: calendarId };
    if (table === "bookable_resources") {
      const current = await this.restGet<Array<{ metadata: Record<string, unknown> | null }>>(
        `bookable_resources?id=eq.${encodeURIComponent(rowId)}&select=metadata`,
      );
      body = { metadata: { ...(current?.[0]?.metadata ?? {}), google_calendar_id: calendarId } };
    }

    const res = await fetch(`${url}/rest/v1/${table}?id=eq.${encodeURIComponent(rowId)}`, {
      method: "PATCH",
      headers: {
        apikey: key,
        Authorization: `Bearer ${key}`,
        "Content-Type": "application/json",
        Prefer: "return=minimal",
      },
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      throw new Error(`Created calendar ${calendarId} but could not store it on ${table}: ${res.status}`);
    }
  }
}
