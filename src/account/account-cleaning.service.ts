import { BadRequestException, ForbiddenException, Injectable, Logger, NotFoundException } from "@nestjs/common";
import { CleaningCalendarSyncService } from "../google-calendar/cleaning-calendar-sync.service";

/**
 * User-facing (self-service) cleaning booking operations. Reschedule is done
 * fully server-side so ownership + slot capacity are enforced with the service
 * role, and the Google Calendar event is moved through the proven sync service
 * (never a naive direct write that would desync the calendar).
 */
@Injectable()
export class AccountCleaningService {
  private readonly logger = new Logger(AccountCleaningService.name);

  constructor(private readonly calendarSync: CleaningCalendarSyncService) {}

  private supabaseRest<T = unknown>(path: string, init: RequestInit = {}): Promise<T> {
    const baseUrl = process.env.SUPABASE_URL?.replace(/\/$/, "");
    const key = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_ANON_KEY;
    if (!baseUrl || !key) throw new Error("Supabase REST not configured");
    return fetch(`${baseUrl}/rest/v1${path}`, {
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
      if (!res.ok) throw new Error((body as any)?.message || `Supabase ${res.status}`);
      return body as T;
    });
  }

  /**
   * Sync one of the user's own bookings to Google Calendar. Lets clients trigger
   * calendar updates (after cancel/complete/create) without admin permissions —
   * so the calendar stays current automatically, no manual reconcile needed.
   */
  async syncOwnBooking(userId: string, bookingId: string) {
    const enc = encodeURIComponent;
    const [booking] = await this.supabaseRest<any[]>(
      `/cleaning_bookings?id=eq.${enc(bookingId)}&select=id,user_id&limit=1`,
    );
    if (!booking) throw new NotFoundException("Booking not found.");
    if (String(booking.user_id) !== String(userId)) {
      throw new ForbiddenException("Not your booking.");
    }
    return this.calendarSync.syncBookingById(bookingId);
  }

  async rescheduleBooking(userId: string, bookingId: string, newSlotId: string) {
    if (!newSlotId) throw new BadRequestException("Pick a new time slot.");

    const enc = encodeURIComponent;
    const [booking] = await this.supabaseRest<any[]>(
      `/cleaning_bookings?id=eq.${enc(bookingId)}&select=id,user_id,client_id,slot_id,status&limit=1`,
    );
    if (!booking) throw new NotFoundException("Booking not found.");

    // Ownership: the booking must belong to this user. Linked-client bookings are
    // admin-managed, so self-service reschedule is limited to the user's own.
    if (String(booking.user_id) !== String(userId)) {
      throw new ForbiddenException("You can only reschedule your own cleanings.");
    }

    const status = String(booking.status ?? "").toLowerCase();
    if (status === "completed" || status === "cancelled") {
      throw new BadRequestException("This cleaning can no longer be rescheduled.");
    }

    const oldSlotId = booking.slot_id as string | null;
    if (newSlotId === oldSlotId) throw new BadRequestException("Pick a different time slot.");

    const [slot] = await this.supabaseRest<any[]>(
      `/cleaning_available_slots?id=eq.${enc(newSlotId)}&select=id,date,start_time,end_time,is_active,current_bookings,max_bookings&limit=1`,
    );
    if (!slot) throw new BadRequestException("That time slot was not found.");
    if (!slot.is_active) throw new BadRequestException("That time slot is not available.");
    if ((slot.current_bookings ?? 0) >= (slot.max_bookings ?? 0)) {
      throw new BadRequestException("That time slot is already full.");
    }

    // Move the booking to the new slot (mark calendar pending until re-synced).
    await this.supabaseRest(`/cleaning_bookings?id=eq.${enc(bookingId)}`, {
      method: "PATCH",
      body: JSON.stringify({ slot_id: newSlotId, google_calendar_sync_status: "pending" }),
    });

    // Free the old slot, take one on the new slot.
    if (oldSlotId) {
      const [os] = await this.supabaseRest<any[]>(
        `/cleaning_available_slots?id=eq.${enc(oldSlotId)}&select=current_bookings&limit=1`,
      );
      if (os) {
        await this.supabaseRest(`/cleaning_available_slots?id=eq.${enc(oldSlotId)}`, {
          method: "PATCH",
          body: JSON.stringify({ current_bookings: Math.max(0, (os.current_bookings ?? 0) - 1) }),
        });
      }
    }
    await this.supabaseRest(`/cleaning_available_slots?id=eq.${enc(newSlotId)}`, {
      method: "PATCH",
      body: JSON.stringify({ current_bookings: (slot.current_bookings ?? 0) + 1 }),
    });

    // Re-sync the Google Calendar event to the new time (best effort — if it
    // fails the booking stays flagged "pending" for an admin reconcile, never broken).
    try {
      await this.calendarSync.syncBookingById(bookingId);
    } catch (e) {
      this.logger.warn(`Reschedule calendar sync failed for ${bookingId}: ${(e as Error).message}`);
    }

    return {
      ok: true,
      bookingId,
      slotId: newSlotId,
      date: slot.date,
      startTime: slot.start_time,
      endTime: slot.end_time,
    };
  }
}
