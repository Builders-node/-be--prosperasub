import { Injectable, Logger, Optional } from "@nestjs/common";
import { GoogleCalendarService } from "./google-calendar.service";

/**
 * Push Beach Club court bookings to a per-court Google Calendar via Google API.
 *
 * Each court can optionally hold its own `google_calendar_id` (e.g. an admin's
 * personal calendar). When set, this service:
 *   - creates a Google Calendar event on booking create
 *   - deletes the event on booking cancel/delete
 * Errors are logged, tagged on the booking row (google_calendar_sync_status/error)
 * and never bubble up to the client — booking creation must not fail because
 * the calendar sync failed.
 */
@Injectable()
export class BeachCourtCalendarSyncService {
  private readonly logger = new Logger(BeachCourtCalendarSyncService.name);

  constructor(@Optional() private readonly googleCalendar?: GoogleCalendarService) {}

  isConfigured(): boolean {
    return !!this.googleCalendar?.isConfigured();
  }

  /** Push a newly-created booking to the court's Google Calendar. Best-effort. */
  async syncCreated(input: {
    bookingId: string;
    courtId: string;
    courtName: string;
    courtGoogleCalendarId: string | null;
    date: string;        // YYYY-MM-DD
    startHour: number;
    endHour: number;
    memberName: string | null;
    notes: string | null;
  }): Promise<{ eventId?: string; skipped?: boolean; error?: string }> {
    const calendarId = input.courtGoogleCalendarId?.trim();
    if (!calendarId) return { skipped: true };
    if (!this.googleCalendar || !this.googleCalendar.isConfigured()) {
      return { skipped: true };
    }

    // Honduras/Belize is a fixed UTC-6 offset, no DST — safe to hard-code.
    const HN_OFFSET = "-06:00";
    const pad = (n: number) => String(n).padStart(2, "0");
    const start = new Date(`${input.date}T${pad(input.startHour)}:00:00${HN_OFFSET}`);
    const end = new Date(`${input.date}T${pad(input.endHour)}:00:00${HN_OFFSET}`);

    try {
      const result = await this.googleCalendar.createEvent({
        summary: input.memberName ? `${input.memberName} — ${input.courtName}` : `${input.courtName} booked`,
        description: [
          `Court: ${input.courtName}`,
          input.memberName ? `Member: ${input.memberName}` : null,
          input.notes ? `Notes: ${input.notes}` : null,
          `Booking ID: ${input.bookingId}`,
        ].filter(Boolean).join("\n"),
        location: "Beach Club",
        start,
        end,
        bookingId: input.bookingId,
      }, calendarId);
      this.logger.log(`[beach-court-sync] booking ${input.bookingId} → event ${result.id} on calendar ${calendarId}`);
      return { eventId: result.id };
    } catch (err) {
      const msg = (err as Error).message ?? String(err);
      this.logger.warn(`[beach-court-sync] create failed for booking ${input.bookingId}: ${msg}`);
      return { error: msg };
    }
  }

  /**
   * Pull the current Google Calendar state for one court and mirror it into
   * our DB. This is the "CRM → Google → us" leg of two-way sync.
   *
   * Rules:
   *  - Events tagged with our `extendedProperties.private.bookingId` are OURS
   *    already — we skip them (avoids echoing).
   *  - New events → we create a matching booking (source: "google_calendar",
   *    idempotency key = event id). Slot-conflicts (row already occupied) are
   *    skipped and reported, we never overwrite an existing booking.
   *  - Cancelled events (status="cancelled") → we delete the matching booking
   *    if it was previously mirrored.
   * Time window: next 60 days from now (enough to cover typical CRM lead time).
   */
  async pullExternalBookings(input: {
    courtId: string;
    /** The calendar in `bookable_resources` — where a booking actually lives. */
    resourceId: string;
    courtName: string;
    courtGoogleCalendarId: string;
    daysAhead?: number;
  }): Promise<{ ok: boolean; created: number; deleted: number; skipped: number; conflicts: number; error?: string }> {
    const stats = { ok: true, created: 0, deleted: 0, skipped: 0, conflicts: 0 };
    if (!this.googleCalendar?.isConfigured()) return { ...stats, ok: false, error: "not_configured" };

    const now = new Date();
    const timeMin = new Date(now.getTime() - 6 * 60 * 60_000).toISOString(); // small buffer back
    const timeMax = new Date(now.getTime() + (input.daysAhead ?? 60) * 86_400_000).toISOString();

    let events: any[];
    try {
      events = await this.googleCalendar.listEvents(timeMin, timeMax, input.courtGoogleCalendarId);
    } catch (e) {
      return { ...stats, ok: false, error: (e as Error).message };
    }

    // Existing mirror-bookings for this court in the window, keyed by google_calendar_event_id.
    const existing = await this.fetchExistingBookings(input.resourceId);
    const seenEventIds = new Set<string>();

    for (const ev of events) {
      const eventId = ev.id;
      if (!eventId) continue;
      // Our own events — skip; they were pushed by us and already exist in DB.
      if (ev.extendedProperties?.private?.bookingId) continue;
      seenEventIds.add(eventId);

      const cancelled = ev.status === "cancelled";
      const mirror = existing.get(eventId);

      if (cancelled) {
        if (mirror) {
          await this.deleteBookingRow(mirror.id);
          stats.deleted++;
        }
        continue;
      }

      const startISO = ev.start?.dateTime ?? ev.start?.date;
      const endISO = ev.end?.dateTime ?? ev.end?.date;
      if (!startISO || !endISO) { stats.skipped++; continue; }

      const startDate = new Date(startISO);
      const endDate = new Date(endISO);
      if (Number.isNaN(startDate.getTime()) || Number.isNaN(endDate.getTime())) { stats.skipped++; continue; }

      // Convert to Honduras wall-clock (UTC-6). Beach Club runs in Honduras tz.
      const hnStart = new Date(startDate.getTime() - 6 * 60 * 60_000);
      const hnEnd = new Date(endDate.getTime() - 6 * 60 * 60_000);
      const dateStr = hnStart.toISOString().slice(0, 10);
      const startHour = hnStart.getUTCHours();
      const endHour = hnEnd.getUTCHours() || (hnEnd.getUTCDate() !== hnStart.getUTCDate() ? 24 : startHour + 1);
      if (endHour <= startHour) { stats.skipped++; continue; }

      const memberName = ev.summary
        ? String(ev.summary).replace(/\s+—\s+.*$/, "").trim().slice(0, 200) // strip "— Court name" suffix
        : null;

      // Honduras wall clock carried as an explicit offset, so the instant is
      // exact rather than whatever zone the server happens to run in.
      const hh = (h: number) => String(h).padStart(2, "0");
      const startAt = `${dateStr}T${hh(startHour)}:00:00-06:00`;
      const endAt = `${dateStr}T${hh(Math.min(endHour, 23))}:00:00-06:00`;

      if (mirror) {
        const moved =
          new Date(mirror.start_at).getTime() !== new Date(startAt).getTime() ||
          new Date(mirror.end_at).getTime() !== new Date(endAt).getTime();
        if (moved) {
          await this.updateBookingRow(mirror.id, {
            start_at: startAt,
            end_at: endAt,
            slot_key: `${input.resourceId}|${dateStr}|${hh(startHour)}:00`,
            label: memberName,
          });
        }
        continue;
      }

      const insertResult = await this.insertBookingRow({
        resource_id: input.resourceId,
        start_at: startAt,
        end_at: endAt,
        slot_key: `${input.resourceId}|${dateStr}|${hh(startHour)}:00`,
        // Nobody's account made this booking — it was blocked in Google by the
        // business itself, and the label is whatever they wrote there.
        subject_ref: null,
        label: memberName,
        notes: ev.description ? String(ev.description).slice(0, 500) : null,
        google_calendar_event_id: eventId,
      });
      if (insertResult === "ok") stats.created++;
      else if (insertResult === "conflict") stats.conflicts++;
      else stats.skipped++;
    }

    // Deletes: any of our mirrored bookings whose Google event disappeared → cancel.
    for (const [eventId, row] of existing) {
      if (seenEventIds.has(eventId)) continue;
      // Only delete rows the Google Calendar clearly no longer has.
      await this.deleteBookingRow(row.id);
      stats.deleted++;
    }

    return stats;
  }

  // ─── Supabase REST helpers (service role) ──────────────────────────────────

  private supabaseRest<T = unknown>(path: string, init: RequestInit = {}): Promise<T> {
    const base = process.env.SUPABASE_URL?.replace(/\/$/, "");
    const key = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_ANON_KEY;
    if (!base || !key) throw new Error("Supabase REST is not configured.");
    return fetch(`${base}/rest/v1${path}`, {
      ...init,
      headers: {
        apikey: key,
        Authorization: `Bearer ${key}`,
        "Content-Type": "application/json",
        Prefer: "return=representation",
        ...(init.headers || {}),
      },
    }).then(async (res) => {
      const body = await res.json().catch(() => null);
      if (!res.ok) throw new Error(body?.message || `Supabase ${res.status}`);
      return body as T;
    });
  }

  /**
   * Bookings this calendar has already mirrored from Google, keyed by event.
   *
   * These used to live in `beach_club_court_bookings`, which the engine
   * cutover emptied — so an event created directly in Google landed in a
   * table nothing read, and the slot stayed bookable in the app. They are
   * engine bookings now, like every other booking.
   */
  private async fetchExistingBookings(resourceId: string): Promise<Map<string, { id: string; start_at: string; end_at: string }>> {
    const rows = await this.supabaseRest<Array<any>>(
      `/bookings?resource_id=eq.${encodeURIComponent(resourceId)}` +
        `&google_calendar_event_id=not.is.null&status=in.(held,confirmed)` +
        `&select=id,start_at,end_at,google_calendar_event_id`,
    ).catch(() => []);
    const m = new Map<string, { id: string; start_at: string; end_at: string }>();
    for (const r of rows ?? []) {
      m.set(String(r.google_calendar_event_id), { id: r.id, start_at: r.start_at, end_at: r.end_at });
    }
    return m;
  }

  private async insertBookingRow(row: Record<string, unknown>): Promise<"ok" | "conflict" | "error"> {
    try {
      await this.supabaseRest(`/bookings`, {
        method: "POST",
        // Confirmed, not held: a time blocked in the provider's own calendar is
        // taken, and a hold would expire and hand it back out.
        body: JSON.stringify({ ...row, status: "confirmed", google_calendar_sync_status: "synced" }),
      });
      return "ok";
    } catch (e) {
      if (/duplicate|unique/i.test((e as Error).message)) return "conflict";
      return "error";
    }
  }

  private async updateBookingRow(id: string, patch: Record<string, unknown>): Promise<void> {
    await this.supabaseRest(`/bookings?id=eq.${encodeURIComponent(id)}`, {
      method: "PATCH",
      body: JSON.stringify({ ...patch, updated_at: new Date().toISOString() }),
    }).catch(() => { /* best effort */ });
  }

  /**
   * The Google event is gone, so the time is free again.
   *
   * Cancelled rather than deleted: the engine keeps what happened, a cancelled
   * booking frees its slot, and a deleted row would take the audit trail of a
   * reservation somebody actually held with it.
   */
  private async deleteBookingRow(id: string): Promise<void> {
    await this.supabaseRest(`/bookings?id=eq.${encodeURIComponent(id)}`, {
      method: "PATCH",
      body: JSON.stringify({ status: "cancelled", updated_at: new Date().toISOString() }),
    }).catch(() => { /* best effort */ });
  }

  /** Delete the Google Calendar event tied to this booking, if any. Best-effort. */
  async syncDeleted(input: { eventId: string; courtGoogleCalendarId: string | null }): Promise<{ ok: boolean; error?: string }> {
    const calendarId = input.courtGoogleCalendarId?.trim();
    if (!calendarId || !this.googleCalendar) return { ok: true };
    try {
      await this.googleCalendar.deleteEvent(input.eventId, calendarId);
      return { ok: true };
    } catch (err) {
      const msg = (err as Error).message ?? String(err);
      this.logger.warn(`[beach-court-sync] delete failed for event ${input.eventId}: ${msg}`);
      return { ok: false, error: msg };
    }
  }
}
