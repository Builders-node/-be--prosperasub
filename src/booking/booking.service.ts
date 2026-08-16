import { BadRequestException, Injectable, Logger, ServiceUnavailableException } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { PrismaService } from "../prisma/prisma.service";
import { EventBusService } from "../events/event-bus.service";
import { ResourceService } from "../resource/resource.service";
import { generateSlots, type Slot } from "./slot-engine";
import { zonedDayRange, zonedWallClockToInstant } from "./zoned-time";
import { BookingPolicy, DEFAULT_SCHEDULE, normalizeSchedule } from "./schedule";

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
    const schedule = normalizeSchedule(
      await this.loadEffectiveBookingSettings(resource.provider_id, resource),
    );
    const raw = generateSlots(bookingModel, schedule, dateISO, resource.capacity ?? undefined);
    // Enforce temporal cutoffs — silently dropped before, now applied server-side
    // so `minNoticeHours` and `maxAdvanceDays` from the provider config actually
    // gate what buyers see and hold. Kept alongside slot generation so callers
    // that read availability get a single, already-filtered list.
    const nowMs = Date.now();
    const noticeCutoffMs = nowMs + schedule.minNoticeHours * 3600_000;
    const advanceCutoffMs = nowMs + schedule.maxAdvanceDays * 86400_000;
    const slots = raw.filter((s) => {
      // Slot times are wall clock in the schedule's zone — resolve to a real
      // instant before comparing against `now`, or the notice window is off by
      // the zone offset.
      const startMs = zonedWallClockToInstant(dateISO, s.from, schedule.timezone).getTime();
      if (Number.isNaN(startMs)) return true;
      return startMs >= noticeCutoffMs && startMs <= advanceCutoffMs;
    });
    return { resourceId, date: dateISO, bookingModel, slots };
  }

  /**
   * Active (held or confirmed) bookings for a resource on a calendar day. Public
   * read — matches the display contract callers had against the legacy tables.
   */
  async listBookings(resourceId: string, dateISO: string) {
    if (!this.prisma.isAvailable()) return [];
    // A calendar day as LIVED at the resource, not a UTC day: with a UTC window
    // an 18:00 Honduras booking (00:00Z the next day) fell outside its own date
    // and the evening slots looked free.
    const resource = await this.resources.getResource(resourceId);
    const schedule = normalizeSchedule(
      await this.loadEffectiveBookingSettings(resource?.provider_id ?? null, resource ?? {}),
    );
    const { start, end } = zonedDayRange(dateISO, schedule.timezone);
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
    const schedule = normalizeSchedule(
      await this.loadEffectiveBookingSettings(resource?.provider_id ?? null, resource ?? {}),
    );
    // Who may take this slot, and how many they already have. The schedule
    // decides that the slot exists; this decides that this customer may have
    // it. Both come from the provider's own settings.
    await this.assertPolicyAllows(schedule.policy, resource, input);

    const slotKey = `${input.resourceId}|${input.date}|${input.from}`;
    // `new Date("...T18:00:00")` with no offset is parsed in the PROCESS's
    // timezone — UTC on Vercel. An 18:00 Honduras slot was therefore stored as
    // 18:00Z = 12:00 Honduras: the customer tapped one time and got another,
    // and the row's own slot_key disagreed with its start_at.
    const startAt = zonedWallClockToInstant(input.date, input.from, schedule.timezone);
    const endAt = zonedWallClockToInstant(input.date, slot.to, schedule.timezone);
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

  /**
   * The provider's rules about the customer, enforced where it counts.
   *
   * The membership gate used to live only in the page: the endpoint took
   * anyone with an account, so a non-member could book a court by calling the
   * API directly, and nothing stopped one member taking every slot of every
   * court for a month.
   *
   * Each rule is off unless the provider turned it on — see DEFAULT_POLICY.
   */
  private async assertPolicyAllows(
    policy: BookingPolicy,
    resource: { provider_id?: string | null; source_service_key?: string | null } | null,
    input: { subjectRef?: string; date: string; resourceId: string },
  ): Promise<void> {
    const subject = input.subjectRef ?? "";
    if (!subject) throw new BadRequestException("subject_required");

    if (policy.requiresMembership) {
      const ok = await this.membershipCoversResource(subject, input.resourceId);
      if (ok === "none") throw new BadRequestException("membership_required");
      if (ok === "other_resource") throw new BadRequestException("resource_not_in_plan");
    }

    if (policy.maxActiveBookings > 0) {
      const active = await this.prisma.booking.count({
        where: {
          subjectRef: subject,
          status: { in: ["held", "confirmed"] },
          startAt: { gte: new Date() },
        },
      });
      if (active >= policy.maxActiveBookings) throw new BadRequestException("too_many_bookings");
    }

    if (policy.maxPerDay > 0) {
      const { start, end } = zonedDayRange(input.date, DEFAULT_SCHEDULE.timezone);
      const sameDay = await this.prisma.booking.count({
        where: {
          subjectRef: subject,
          status: { in: ["held", "confirmed"] },
          startAt: { gte: start, lt: end },
        },
      });
      if (sameDay >= policy.maxPerDay) throw new BadRequestException("daily_limit_reached");
    }
  }

  /**
   * Does this subject hold a live subscription to the resource's provider?
   *
   * Beach memberships are the only subscriptions that gate a resource today.
   *
   * Three answers, not two: no membership at all, a membership that does not
   * include THIS court, and yes. The middle one exists because a plan can now
   * name the courts it opens — a tennis-only membership should be told it is
   * the wrong court, not that it is not a member.
   */
  private async membershipCoversResource(
    subjectRef: string,
    resourceId: string,
  ): Promise<"ok" | "none" | "other_resource"> {
    const userId = subjectRef.startsWith("user:") ? subjectRef.slice(5) : subjectRef;
    if (!userId) return "none";
    const today = new Date().toISOString().slice(0, 10);

    // The live memberships this customer holds, and what each was bought from.
    const subs = await this.rest<Array<{ plan_id: string | null }>>(
      `beach_club_subscriptions?select=plan_id&user_id=eq.${encodeURIComponent(userId)}` +
      `&status=eq.active&payment_status=eq.paid&end_date=gte.${today}`,
    );
    if (!subs?.length) return "none";

    // What each plan grants. A plan naming no resources grants all of its
    // provider's — which is what a single all-access membership means, and
    // what every plan written before this column existed still means.
    const planIds = [...new Set(subs.map((s) => s.plan_id).filter((id): id is string => !!id))];
    if (!planIds.length) return "ok";

    const plans = await this.rest<Array<{ resource_ids: unknown }>>(
      `provider_plans?select=resource_ids&source_service_key=eq.beach` +
      `&source_plan_id=in.(${planIds.map((id) => encodeURIComponent(id)).join(",")})`,
    );
    // No mirror row yet is not a reason to refuse a paying member.
    if (!plans?.length) return "ok";

    for (const plan of plans) {
      const ids = Array.isArray(plan.resource_ids) ? plan.resource_ids.map(String) : [];
      if (ids.length === 0 || ids.includes(resourceId)) return "ok";
    }
    return "other_resource";
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
  async cancel(bookingId: string, actor?: { subjectRef?: string; isStaff?: boolean }) {
    this.assertDb();
    const b = await this.prisma.booking.findUnique({ where: { id: bookingId } });
    if (!b) throw new BadRequestException("booking_not_found");

    // Whose booking this is. Before this check the endpoint cancelled any
    // booking by id, so one customer could cancel another's court with nothing
    // but the id — staff still can, and that is the point of the exception.
    if (actor && !actor.isStaff) {
      if (!actor.subjectRef || actor.subjectRef !== b.subjectRef) {
        throw new BadRequestException("not_your_booking");
      }
      const schedule = normalizeSchedule(
        await this.loadEffectiveBookingSettings(b.providerId ?? null, {}),
      );
      const noticeMs = schedule.policy.cancelNoticeHours * 3600_000;
      if (noticeMs > 0 && b.startAt.getTime() - Date.now() < noticeMs) {
        throw new BadRequestException("cancel_window_passed");
      }
    }
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

  /**
   * Effective booking calendar for a resource: its own hours if it has any,
   * then the provider's default.
   *
   * The resource's own `hours` used to be ignored entirely — the only
   * per-resource lookup was a beach-shaped one against `beach_club_courts`,
   * so a calendar belonging to any other kind of business could not carry
   * opening hours at all, and the copy sitting on the universal row was
   * decorative. It is the authored value now; the beach columns stay as a
   * fallback for courts written before the editor moved.
   */
  private async loadEffectiveBookingSettings(
    providerId: string | null,
    resource: {
      hours?: unknown;
      source_service_key?: string | null;
      source_resource_id?: string | null;
    },
  ): Promise<unknown> {
    const own = this.scheduleFromResourceHours(resource?.hours);
    if (own) return own;

    if (resource?.source_service_key === "beach" && resource.source_resource_id) {
      const rows = await this.rest<Array<{
        booking_settings: unknown;
        open_hour: number | null;
        close_hour: number | null;
        slot_minutes: number | null;
      }>>(
        `beach_club_courts?select=booking_settings,open_hour,close_hour,slot_minutes` +
          `&id=eq.${encodeURIComponent(resource.source_resource_id)}&limit=1`,
      );
      const court = rows?.[0];
      if (court?.booking_settings) return court.booking_settings;

      // A court carries its own opening hours (open_hour / close_hour /
      // slot_minutes — what the admin edits on the Courts tab). Only
      // `booking_settings` was ever read, and it is null for every court, so the
      // engine fell through to the provider default and published 06:00–18:00
      // for courts configured 08:00–19:00. Bookable hours the operator never
      // set, and no bookable hours in the evening they did.
      const schedule = this.buildFromCourtHours(court);
      if (schedule) return schedule;
    }
    return this.loadBookingSettings(providerId);
  }

  /**
   * A calendar's own hours, in either shape it may be written in.
   *
   *   { weekly: [...] }                       — a full week, passed straight through
   *   { open_hour, close_hour, slot_minutes } — the same hours every day
   *
   * The second is what the Calendars editor writes and what the beach backfill
   * left behind, so both have to be understood. Anything else — null, an empty
   * object, a close before an open — is not an answer, and the caller falls
   * through to the provider's default rather than inventing a day.
   */
  private scheduleFromResourceHours(hours: unknown): unknown | null {
    if (!hours || typeof hours !== "object") return null;
    const h = hours as Record<string, unknown>;
    if (Array.isArray(h.weekly) && h.weekly.length) return h;
    return this.buildFromCourtHours({
      open_hour: Number(h.open_hour),
      close_hour: Number(h.close_hour),
      slot_minutes: Number(h.slot_minutes),
    });
  }

  /**
   * Build a Schedule from open/close hour columns. Such a calendar keeps the
   * same hours every day of the week, including weekends — a beach club that
   * shut on Saturday would be an odd beach club, and the provider default
   * disables them.
   */
  private buildFromCourtHours(court: {
    open_hour: number | null; close_hour: number | null; slot_minutes: number | null;
  } | undefined): unknown | null {
    const open = Number(court?.open_hour);
    const close = Number(court?.close_hour);
    if (!Number.isFinite(open) || !Number.isFinite(close) || close <= open) return null;
    const hh = (h: number) => `${String(h).padStart(2, "0")}:00`;
    const day = { enabled: true, from: hh(open), to: hh(close) };
    return {
      weekly: Array.from({ length: 7 }, () => ({ ...day })),
      sessionDurationMin: Number(court?.slot_minutes) > 0 ? Number(court?.slot_minutes) : 60,
    };
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
