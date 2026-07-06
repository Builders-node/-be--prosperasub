import { BadRequestException, Injectable, Logger, ServiceUnavailableException } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { PrismaService } from "../prisma/prisma.service";
import { EventBusService } from "../events/event-bus.service";
import { ResourceService } from "../resource/resource.service";
import { generateSlots, type Slot } from "./slot-engine";
import { normalizeSchedule } from "./schedule";

export interface AvailabilityResult {
  resourceId: string;
  date: string;
  bookingModel: string | null;
  slots: Slot[];
  reason?: string;
}

const HOLD_TTL_MINUTES = 10;

/**
 * Booking domain — the unified engine. Read side: availability (dispatch on
 * booking_model). Write side: a Booking aggregate whose 'held' state is a hold
 * with a TTL; `bookings_active_slot_uidx` (partial unique) makes double-booking
 * impossible at the DB. Emits `booking.*` so Order/Notification/Analytics react.
 */
@Injectable()
export class BookingService {
  private readonly logger = new Logger(BookingService.name);

  constructor(
    private readonly resources: ResourceService,
    private readonly config: ConfigService,
    private readonly prisma: PrismaService,
    private readonly eventBus: EventBusService,
  ) {}

  // ── Read side ────────────────────────────────────────────────────────────
  async getAvailability(resourceId: string, dateISO: string): Promise<AvailabilityResult> {
    const resource = await this.resources.getResource(resourceId);
    if (!resource) {
      return { resourceId, date: dateISO, bookingModel: null, slots: [], reason: "resource_not_found" };
    }
    const type = await this.resources.getType(resource.type);
    const bookingModel = type?.booking_model ?? "time_slot";
    const schedule = normalizeSchedule(await this.loadBookingSettings(resource.provider_id));
    const slots = generateSlots(bookingModel, schedule, dateISO, resource.capacity ?? undefined);
    return { resourceId, date: dateISO, bookingModel, slots };
  }

  /**
   * Active (held or confirmed) bookings for a resource on a calendar day. Public
   * read — matches the display contract callers had against the legacy tables.
   */
  async listBookings(resourceId: string, dateISO: string) {
    if (!this.prisma.isAvailable()) return [];
    const start = new Date(`${dateISO}T00:00:00.000Z`);
    const end = new Date(start.getTime() + 24 * 60 * 60 * 1000);
    const rows = await this.prisma.booking.findMany({
      where: {
        resourceId,
        status: { in: ["held", "confirmed"] },
        startAt: { gte: start, lt: end },
      },
      orderBy: { startAt: "asc" },
    });
    return rows.map((b) => ({
      id: b.id,
      resource_id: b.resourceId,
      subject_ref: b.subjectRef,
      start_at: b.startAt,
      end_at: b.endAt,
      slot_key: b.slotKey,
      status: b.status,
      label: b.label,
      notes: b.notes,
      google_calendar_event_id: b.googleCalendarEventId,
      google_calendar_sync_status: b.googleCalendarSyncStatus,
    }));
  }

  // ── Write side ───────────────────────────────────────────────────────────
  /** Tentatively hold a slot (TTL). Rejects if the slot isn't generated or is already claimed. */
  async hold(input: { resourceId: string; date: string; from: string; subjectRef?: string; ttlMinutes?: number; label?: string | null; notes?: string | null }) {
    this.assertDb();
    const avail = await this.getAvailability(input.resourceId, input.date);
    const slot = avail.slots.find((s) => s.from === input.from);
    if (!slot) throw new BadRequestException("slot_unavailable");

    const resource = await this.resources.getResource(input.resourceId);
    const slotKey = `${input.resourceId}|${input.date}|${input.from}`;
    const startAt = new Date(`${input.date}T${input.from}:00`);
    const endAt = new Date(`${input.date}T${slot.to}:00`);
    const now = new Date();

    // Free any expired holds on this slot so a stale hold can't block it.
    await this.prisma.booking.updateMany({
      where: { resourceId: input.resourceId, slotKey, status: "held", expiresAt: { lt: now } },
      data: { status: "released" },
    });

    const expiresAt = new Date(now.getTime() + (input.ttlMinutes ?? HOLD_TTL_MINUTES) * 60_000);
    try {
      const booking = await this.prisma.booking.create({
        data: {
          resourceId: input.resourceId,
          providerId: resource?.provider_id ?? null,
          subjectRef: input.subjectRef ?? null,
          startAt, endAt, slotKey, status: "held", expiresAt,
          label: input.label ?? null,
          notes: input.notes ?? null,
        },
      });
      await this.eventBus.publish({
        type: "booking.SlotHeld",
        subjectRef: input.subjectRef ?? `booking:${booking.id}`,
        payload: { bookingId: booking.id, resourceId: input.resourceId, slotKey, from: input.from, to: slot.to, expiresAt },
      });
      return { held: true, bookingId: booking.id, expiresAt };
    } catch (err) {
      if ((err as { code?: string })?.code === "P2002") {
        return { held: false, reason: "slot_taken" as const };
      }
      throw err;
    }
  }

  /** Confirm a hold (e.g. once its Order is paid). */
  async confirm(bookingId: string, orderRef?: string) {
    this.assertDb();
    const res = await this.prisma.booking.updateMany({
      where: { id: bookingId, status: "held" },
      data: { status: "confirmed", orderRef: orderRef ?? null, expiresAt: null },
    });
    if (res.count === 0) throw new BadRequestException("hold_not_found_or_not_held");
    const b = await this.prisma.booking.findUnique({ where: { id: bookingId } });
    await this.eventBus.publish({
      type: "booking.BookingConfirmed",
      subjectRef: b?.subjectRef ?? `booking:${bookingId}`,
      payload: { bookingId, resourceId: b?.resourceId ?? null, orderRef: orderRef ?? null },
    });
    return { confirmed: true, bookingId };
  }

  /** Cancel a booking and promote the next waitlisted subject for its slot. */
  async cancel(bookingId: string) {
    this.assertDb();
    const b = await this.prisma.booking.findUnique({ where: { id: bookingId } });
    if (!b) throw new BadRequestException("booking_not_found");
    await this.prisma.booking.update({ where: { id: bookingId }, data: { status: "cancelled" } });
    await this.eventBus.publish({
      type: "booking.BookingCancelled",
      subjectRef: b.subjectRef ?? `booking:${bookingId}`,
      payload: { bookingId, resourceId: b.resourceId, slotKey: b.slotKey },
    });
    await this.promoteWaitlist(b.resourceId, b.slotKey);
    return { cancelled: true, bookingId };
  }

  async joinWaitlist(input: { resourceId: string; date: string; from: string; subjectRef?: string }) {
    this.assertDb();
    const slotKey = `${input.resourceId}|${input.date}|${input.from}`;
    const row = await this.prisma.bookingWaitlist.create({
      data: { resourceId: input.resourceId, slotKey, subjectRef: input.subjectRef ?? null },
    });
    await this.eventBus.publish({
      type: "booking.WaitlistJoined",
      subjectRef: input.subjectRef ?? `waitlist:${row.id}`,
      payload: { waitlistId: row.id, resourceId: input.resourceId, slotKey },
    });
    return { waitlistId: row.id };
  }

  /** Cron sweep: release expired holds, emit HoldExpired, promote waitlist. */
  async expireHolds(): Promise<{ expired: number }> {
    if (!this.prisma.isAvailable()) return { expired: 0 };
    const now = new Date();
    const expired = await this.prisma.booking.findMany({ where: { status: "held", expiresAt: { lt: now } } });
    for (const b of expired) {
      await this.prisma.booking.update({ where: { id: b.id }, data: { status: "released" } });
      await this.eventBus.publish({
        type: "booking.HoldExpired",
        subjectRef: b.subjectRef ?? `booking:${b.id}`,
        payload: { bookingId: b.id, resourceId: b.resourceId, slotKey: b.slotKey },
      });
      await this.promoteWaitlist(b.resourceId, b.slotKey);
    }
    return { expired: expired.length };
  }

  private async promoteWaitlist(resourceId: string, slotKey: string): Promise<void> {
    const next = await this.prisma.bookingWaitlist.findFirst({
      where: { resourceId, slotKey, status: "waiting" },
      orderBy: { createdAt: "asc" },
    });
    if (!next) return;
    await this.prisma.bookingWaitlist.update({ where: { id: next.id }, data: { status: "promoted" } });
    await this.eventBus.publish({
      type: "booking.WaitlistPromoted",
      subjectRef: next.subjectRef ?? `waitlist:${next.id}`,
      payload: { waitlistId: next.id, resourceId, slotKey },
    });
  }

  private assertDb(): void {
    if (!this.prisma.isAvailable()) throw new ServiceUnavailableException("Booking store unavailable");
  }

  // ── Config ───────────────────────────────────────────────────────────────
  private async loadBookingSettings(providerId: string | null): Promise<unknown> {
    if (!providerId) return null;
    const rows = await this.rest<Array<{ booking_settings: unknown }>>(
      `providers?select=booking_settings&id=eq.${encodeURIComponent(providerId)}&limit=1`,
    );
    return rows?.[0]?.booking_settings ?? null;
  }

  private async rest<T>(path: string): Promise<T | null> {
    const base = this.config.get<string>("SUPABASE_URL")?.replace(/\/$/, "");
    const key =
      this.config.get<string>("SUPABASE_SERVICE_ROLE_KEY") || this.config.get<string>("SUPABASE_ANON_KEY");
    if (!base || !key) return null;
    try {
      const res = await fetch(`${base}/rest/v1/${path}`, {
        headers: { apikey: key, Authorization: `Bearer ${key}` },
      });
      if (!res.ok) {
        this.logger.warn(`[booking.rest] ${path} → ${res.status}`);
        return null;
      }
      return (await res.json()) as T;
    } catch (err) {
      this.logger.error(`[booking.rest] ${path} network error: ${(err as Error).message}`);
      return null;
    }
  }
}
