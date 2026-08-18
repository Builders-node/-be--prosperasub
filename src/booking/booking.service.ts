import { BadRequestException, ForbiddenException, Injectable, Logger, ServiceUnavailableException } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { PrismaService } from "../prisma/prisma.service";
import { EventBusService } from "../events/event-bus.service";
import { ResourceService } from "../resource/resource.service";
import { generateSlots, type Slot } from "./slot-engine";
import { zonedDayRange, zonedWallClockToInstant } from "./zoned-time";
import { BookingPolicy, DEFAULT_SCHEDULE, normalizeSchedule } from "./schedule";
import {
  bookedHours, hourAllowanceFor, periodWindow, type AllowancePeriod,
} from "./allowance";

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
/** `plan_id` / `package_id` / `meal_plan_id` — whatever the table calls it. */
function ids(rows: Array<Record<string, unknown>> | null, column: string): string[] {
  return [...new Set((rows ?? []).map((r) => r[column]).filter((v): v is string => !!v))];
}

/**
 * Every calendar a plan names, across both places it can name one: the flat
 * `resource_ids` column and the per-line `resource_ids` inside `entitlements`.
 * Empty means "all of them" and the caller reads it that way.
 */
/** How long a slot is, in hours, from the wall-clock times the schedule gave. */
function slotHours(dateISO: string, from: string, to: string, timeZone: string): number {
  const start = zonedWallClockToInstant(dateISO, from, timeZone).getTime();
  const end = zonedWallClockToInstant(dateISO, to, timeZone).getTime();
  const ms = end > start ? end - start : 3_600_000;
  return Math.round((ms / 3_600_000) * 100) / 100;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Honduras does not observe DST, so one offset is the whole story. */
const PLATFORM_UTC_OFFSET_MINUTES = -360;

function grantedResourceIds(plan: { resource_ids?: unknown; entitlements?: unknown }): string[] {
  const out = new Set<string>();
  const collect = (value: unknown) => {
    if (Array.isArray(value)) value.forEach((v) => { if (typeof v === "string" && v) out.add(v); });
  };
  collect(plan.resource_ids);
  if (Array.isArray(plan.entitlements)) {
    for (const line of plan.entitlements) {
      if (line && typeof line === "object") collect((line as Record<string, unknown>).resource_ids);
    }
  }
  return [...out];
}

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
  async hold(input: {
    resourceId: string; date: string; from: string; subjectRef?: string;
    ttlMinutes?: number; label?: string | null; notes?: string | null;
    /**
     * Skip the customer-facing policy (membership required, hours per period,
     * how far ahead one may book). Only ever set for a booking the provider's
     * own desk is taking: a walk-in paying cash has no membership, and the
     * business deciding to seat them is the business's call, not the engine's.
     */
    bypassPolicy?: boolean;
  }) {
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
    if (!input.bypassPolicy) await this.assertPolicyAllows(schedule.policy, resource, {
      ...input,
      // The slot's real length, so an allowance of "4 hours" is four hours and
      // not four bookings of whatever size this calendar happens to sell.
      hours: slotHours(input.date, input.from, slot.to, schedule.timezone),
    });

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
   * Every booking a customer holds, across every business.
   *
   * The customer's own history read `beach_club_court_bookings`, which the
   * cutover emptied — so a member who books courts every week saw nothing
   * there. Bookings live in one table now and this is the only way to ask for
   * "mine", because that table is service-role only.
   */
  async listForSubject(subjectRef: string, opts: { from?: string; to?: string; limit?: number } = {}) {
    if (!this.prisma.isAvailable()) return [];
    const rows = await this.prisma.booking.findMany({
      where: {
        subjectRef,
        status: { in: ["held", "confirmed", "completed", "no_show"] },
        ...(opts.from || opts.to
          ? {
              startAt: {
                ...(opts.from ? { gte: new Date(`${opts.from}T00:00:00Z`) } : {}),
                ...(opts.to ? { lt: new Date(`${opts.to}T23:59:59Z`) } : {}),
              },
            }
          : {}),
      },
      orderBy: { startAt: "desc" },
      take: Math.min(Math.max(opts.limit ?? 100, 1), 500),
    });
    return this.decorate(rows);
  }

  /** Every booking on a provider's calendars in a window — their day, their week. */
  async listForProvider(providerId: string, opts: { from?: string; to?: string } = {}) {
    if (!this.prisma.isAvailable()) return [];
    // `provider_id` is denormalised onto the booking, but rows written before
    // that column existed carry only the resource — so resolve the provider's
    // resources too rather than losing their history.
    const resources = await this.resources.listResources({ providerId });
    const resourceIds = resources.map((r) => r.id);
    const rows = await this.prisma.booking.findMany({
      where: {
        OR: [{ providerId }, ...(resourceIds.length ? [{ resourceId: { in: resourceIds } }] : [])],
        status: { in: ["held", "confirmed", "completed", "no_show"] },
        ...(opts.from || opts.to
          ? {
              startAt: {
                ...(opts.from ? { gte: new Date(`${opts.from}T00:00:00Z`) } : {}),
                ...(opts.to ? { lt: new Date(`${opts.to}T23:59:59Z`) } : {}),
              },
            }
          : {}),
      },
      orderBy: { startAt: "asc" },
      take: 500,
    });
    return this.decorate(rows);
  }

  /**
   * Bookings with the name of what was booked AND of who booked it — an id
   * tells nobody anything.
   *
   * The customer's name was the piece missing: a booking carries
   * `subject_ref = "user:<uuid>"`, and `label` is only ever set when staff took
   * the booking over the counter. So the provider's own calendar showed the
   * court's name in the customer's place, which they already knew, and the one
   * thing they needed — who is coming — was nowhere on the screen.
   */
  private async decorate(rows: Array<Record<string, any>>) {
    const ids = [...new Set(rows.map((r) => r.resourceId))];
    const names = new Map<string, { name: string; provider_id: string | null }>();
    for (const id of ids) {
      const r = await this.resources.getResource(id);
      if (r) names.set(id, { name: r.name, provider_id: r.provider_id ?? null });
    }

    const people = await this.subjectNames(rows.map((r) => r.subjectRef));

    return rows.map((b) => ({
      id: b.id,
      resource_id: b.resourceId,
      resource_name: names.get(b.resourceId)?.name ?? null,
      provider_id: b.providerId ?? names.get(b.resourceId)?.provider_id ?? null,
      subject_ref: b.subjectRef,
      customer_name: b.label ?? people.get(String(b.subjectRef ?? "")) ?? null,
      start_at: b.startAt,
      end_at: b.endAt,
      slot_key: b.slotKey,
      status: b.status,
      label: b.label ?? null,
      notes: b.notes ?? null,
    }));
  }

  /**
   * Names for `user:<uuid>` subjects, in one query.
   *
   * Best effort by design: a booking whose subject is not a platform user (a
   * walk-in taken by staff, an old row) simply has no name, and the caller
   * falls back to whatever label it was given.
   */
  private async subjectNames(subjectRefs: Array<string | null | undefined>): Promise<Map<string, string>> {
    const out = new Map<string, string>();
    const ids = [...new Set(
      subjectRefs
        .map((r) => (typeof r === "string" && r.startsWith("user:") ? r.slice(5) : null))
        .filter((id): id is string => !!id && UUID_RE.test(id)),
    )];
    if (!ids.length) return out;

    const rows = await this.rest<Array<{ id: string; name: string | null; display_name: string | null; email: string | null }>>(
      `users?select=id,name,display_name,email&id=in.(${ids.map(encodeURIComponent).join(",")})`,
    );
    (rows ?? []).forEach((u) => {
      const name = u.display_name || u.name || u.email;
      if (name) out.set(`user:${u.id}`, name);
    });
    return out;
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
    input: { subjectRef?: string; date: string; resourceId: string; hours?: number },
  ): Promise<void> {
    const subject = input.subjectRef ?? "";
    if (!subject) throw new BadRequestException("subject_required");

    if (policy.requiresMembership) {
      const ok = await this.membershipCoversResource(subject, input.resourceId);
      if (ok === "none") throw new BadRequestException("membership_required");
      if (ok === "other_resource") throw new BadRequestException("resource_not_in_plan");
    }

    // How much of the plan's allowance is left. Independent of
    // `requiresMembership`: if a customer's plan grants a number of hours, that
    // number is what they have, whether or not the calendar is members-only.
    if (resource?.provider_id) {
      const usage = await this.hourUsage(subject, resource.provider_id, input.resourceId);
      if (usage && usage.used + (input.hours ?? 1) > usage.limit + 1e-6) {
        throw new BadRequestException("hour_allowance_reached");
      }
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
   * Which of a provider's calendars this customer's plans open.
   *
   * The same decision as `membershipCoversResource`, asked for the whole list
   * at once so the booking screen can say what is included BEFORE somebody
   * taps a court they cannot have. Narrowing a plan without this turns a
   * pricing decision into a surprise error.
   *
   * `all: true` means every calendar — either the provider does not gate on
   * membership, or the plans name nothing, which is what all-access means.
   */
  async coverageFor(
    subjectRef: string,
    providerId: string,
    resourceId?: string,
  ): Promise<{
    member: boolean; all: boolean; resourceIds: string[];
    allowance: { limit: number; used: number; remaining: number; period: string; resetsOn: string } | null;
  }> {
    const userId = subjectRef.startsWith("user:") ? subjectRef.slice(5) : subjectRef;
    const empty = { member: false, all: false, resourceIds: [] as string[], allowance: null };
    if (!userId || !providerId) return empty;

    const plans = await this.plansHeldBy(userId, providerId);
    if (plans === null) return empty;

    // The allowance is asked about one calendar, because a plan may cap one and
    // not another. Without a calendar named, answer for the first one it opens.
    const askAbout = resourceId ?? grantedResourceIds(plans[0] ?? {})[0] ?? "";
    const usage = askAbout ? await this.hourUsage(subjectRef, providerId, askAbout) : null;
    const allowance = usage
      ? {
          limit: usage.limit, used: usage.used, remaining: usage.remaining,
          period: usage.period, resetsOn: usage.resetsOn.toISOString(),
        }
      : null;

    if (!plans.length) return { member: true, all: true, resourceIds: [], allowance };

    const named = new Set<string>();
    for (const plan of plans) {
      const ids = grantedResourceIds(plan);
      // A plan that names nothing opens everything, and one such plan is
      // enough — no point listing calendars after that.
      if (!ids.length) return { member: true, all: true, resourceIds: [], allowance };
      ids.forEach((id) => named.add(id));
    }
    return { member: true, all: false, resourceIds: [...named], allowance };
  }

  /**
   * The allowance on this calendar and how much of it is gone, or null when
   * the customer's plans do not count hours.
   *
   * Counts every hold and confirmed booking the customer has in the current
   * period on the calendars the allowance covers — a hold is a reservation, so
   * it spends the allowance until it expires or is released.
   */
  private async hourUsage(
    subjectRef: string,
    providerId: string,
    resourceId: string,
  ): Promise<{ limit: number; used: number; remaining: number; period: AllowancePeriod; resetsOn: Date } | null> {
    const userId = subjectRef.startsWith("user:") ? subjectRef.slice(5) : subjectRef;
    if (!userId) return null;

    const plans = await this.plansHeldBy(userId, providerId);
    const allowance = hourAllowanceFor(plans, resourceId);
    if (!allowance) return null;

    const { start, end } = periodWindow(allowance.period, new Date(), PLATFORM_UTC_OFFSET_MINUTES);
    // Scoped to the calendars the allowance is about: naming a court in a plan
    // narrows what it opens, so it must also narrow what it counts.
    const covered = new Set<string>();
    (plans ?? []).forEach((p) => grantedResourceIds(p).forEach((id) => covered.add(id)));

    const spans = await this.prisma.booking.findMany({
      where: {
        subjectRef,
        providerId,
        status: { in: ["held", "confirmed", "completed"] },
        startAt: { gte: start, lt: end },
        ...(covered.size ? { resourceId: { in: [...covered] } } : {}),
      },
      select: { startAt: true, endAt: true },
    });

    const used = bookedHours(spans);
    return {
      limit: allowance.limit,
      used,
      remaining: Math.max(0, Math.round((allowance.limit - used) * 100) / 100),
      period: allowance.period,
      resetsOn: end,
    };
  }

  /**
   * Does this subject hold a live subscription that opens this calendar?
   *
   * Three answers, not two: no subscription at all, a subscription whose plan
   * does not name THIS calendar, and yes. The middle one exists because a plan
   * can name the calendars it opens — a tennis-only membership should be told
   * it is the wrong court, not that it is not a member.
   *
   * It used to ask `beach_club_subscriptions` and beach plans, full stop. So
   * `requiresMembership` was a beach feature: any other provider who turned it
   * on would have refused every one of their own paying customers. A
   * subscription is recorded in four places and this reads all of them.
   */
  private async membershipCoversResource(
    subjectRef: string,
    resourceId: string,
  ): Promise<"ok" | "none" | "other_resource"> {
    const userId = subjectRef.startsWith("user:") ? subjectRef.slice(5) : subjectRef;
    if (!userId) return "none";
    const resource = await this.resources.getResource(resourceId);
    if (!resource?.provider_id) return "none";

    const plans = await this.plansHeldBy(userId, resource.provider_id);
    return BookingService.decideCoverage(resourceId, plans);
  }

  /**
   * The universal plan rows behind every live subscription this customer holds
   * with this provider.
   *
   * `null` means "no subscription at all" — the only answer that refuses
   * somebody. An empty array means they are subscribed but the plan could not
   * be resolved to a universal row, which is a gap in our mirroring and not a
   * reason to turn a paying member away at the gate.
   */
  private async plansHeldBy(
    userId: string,
    providerId: string,
  ): Promise<Array<{ id?: string | null; period?: string | null; resource_ids?: unknown; entitlements?: unknown }> | null> {
    const today = new Date().toISOString().slice(0, 10);
    const uid = encodeURIComponent(userId);

    const provider = (await this.rest<Array<{ source_service_key: string | null; source_provider_id: string | null }>>(
      `providers?select=source_service_key,source_provider_id&id=eq.${encodeURIComponent(providerId)}&limit=1`,
    ))?.[0];

    // 1. The universal table. A source key on a row usually means the stale
    //    2026 backfill, which the legacy read below answers for — except
    //    'beach', whose memberships were migrated and are now written here.
    const universal = await this.rest<Array<{ plan_id: string | null }>>(
      `provider_subscriptions?select=plan_id&user_id=eq.${uid}` +
        `&provider_id=eq.${encodeURIComponent(providerId)}` +
        `&status=eq.active&or=(source_service_key.is.null,source_service_key.eq.beach)`,
    );
    const universalPlanIds = (universal ?? []).map((r) => r.plan_id).filter((id): id is string => !!id);

    // 2. The service's own table, whichever it is. Each names its plan
    //    differently and calls "still running" something different.
    const legacy = await this.legacyPlanIds(provider ?? null, uid, today);

    if (!universalPlanIds.length && !legacy.subscribed) return null;

    const clauses: string[] = [];
    if (universalPlanIds.length) {
      clauses.push(`id.in.(${universalPlanIds.map(encodeURIComponent).join(",")})`);
    }
    if (legacy.planIds.length && provider?.source_service_key) {
      // A legacy plan id is not a `provider_plans.id` — it is what the mirror
      // row records as its source.
      clauses.push(
        `and(source_service_key.eq.${encodeURIComponent(provider.source_service_key)},` +
          `source_plan_id.in.(${legacy.planIds.map(encodeURIComponent).join(",")}))`,
      );
    }
    if (!clauses.length) return [];

    const rows = await this.rest<Array<{ id: string; period: string | null; resource_ids: unknown; entitlements: unknown }>>(
      // `id` and `period` are the allowance's: one plan counts once however
      // many subscriptions to it a customer holds, and a line with no period of
      // its own inherits the plan's.
      `provider_plans?select=id,period,resource_ids,entitlements&or=(${clauses.join(",")})`,
    );
    return rows ?? [];
  }

  /** Live subscriptions in the per-service tables, and the plan ids they name. */
  private async legacyPlanIds(
    provider: { source_service_key: string | null; source_provider_id: string | null } | null,
    uid: string,
    today: string,
  ): Promise<{ subscribed: boolean; planIds: string[] }> {
    const key = provider?.source_service_key ?? "";
    const legacyProvider = provider?.source_provider_id ?? "";

    // The beach has no legacy branch any more: its memberships are universal
    // rows, read above like any other.

    if (key === "cleaning" && legacyProvider) {
      const rows = await this.rest<Array<{ package_id: string | null }>>(
        `cleaning_subscriptions?select=package_id&user_id=eq.${uid}` +
          `&provider_id=eq.${encodeURIComponent(legacyProvider)}` +
          `&subscription_status=eq.active`,
      );
      return { subscribed: !!rows?.length, planIds: ids(rows, "package_id") };
    }

    if (key === "food" && legacyProvider) {
      const rows = await this.rest<Array<{ meal_plan_id: string | null }>>(
        `food_subscriptions?select=meal_plan_id&user_id=eq.${uid}` +
          `&provider_id=eq.${encodeURIComponent(legacyProvider)}` +
          `&status=eq.active&payment_status=eq.paid&end_date=gte.${today}`,
      );
      return { subscribed: !!rows?.length, planIds: ids(rows, "meal_plan_id") };
    }

    return { subscribed: false, planIds: [] };
  }

  /**
   * The decision itself, given what the customer holds. Pure, because this is
   * the part that refuses people.
   *
   * A plan that names no calendars opens all of its provider's — that is what
   * a single all-access membership means, and what every plan written before
   * the column existed still means.
   */
  static decideCoverage(
    resourceId: string,
    plans: Array<{ resource_ids?: unknown; entitlements?: unknown }> | null,
  ): "ok" | "none" | "other_resource" {
    if (plans === null) return "none";
    if (!plans.length) return "ok";
    for (const plan of plans) {
      const named = grantedResourceIds(plan);
      if (!named.length || named.includes(resourceId)) return "ok";
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

  /**
   * A booking taken by the business, for someone else.
   *
   * Every write on this engine binds the booking to whoever called it, which
   * is right for a customer and useless for a front desk: a provider phoning
   * back a member, or seating a walk-in, could only book the court under their
   * own name. This is the one path where the subject comes from the body, so
   * it is also the one that has to prove who is asking.
   *
   * `customerUserId` is preferred — the booking then shows up in that person's
   * own list and counts against their allowance. Without one it is a named
   * walk-in: the label carries the name, and nothing else about them is
   * invented.
   */
  async bookForCustomer(input: {
    resourceId: string;
    date: string;
    from: string;
    customerUserId?: string | null;
    customerName?: string | null;
    notes?: string | null;
  }, actor: { userId: string; isStaff: boolean }) {
    this.assertDb();
    const resource = await this.resources.getResource(input.resourceId);
    if (!resource) throw new BadRequestException("resource_not_found");
    await this.assertRunsProvider(resource.provider_id ?? null, actor);

    const name = (input.customerName ?? "").trim();
    if (!input.customerUserId && !name) {
      throw new BadRequestException("Say who this booking is for.");
    }

    const held = await this.hold({
      resourceId: input.resourceId,
      date: input.date,
      from: input.from,
      subjectRef: input.customerUserId ? `user:${input.customerUserId}` : `desk:${actor.userId}`,
      // The desk decides. See hold().
      bypassPolicy: true,
      label: name || null,
      notes: input.notes ?? null,
    });
    if (!held.held || !held.bookingId) {
      throw new BadRequestException(held.reason === "slot_taken" ? "That slot is already taken." : "slot_unavailable");
    }
    await this.confirm(held.bookingId);
    return { bookingId: held.bookingId };
  }

  /**
   * Does this person run this business? Same rule as the occurrences endpoints:
   * a platform admin, the provider's owner, or one of its managers. A provider
   * with no owner (Apartment Cleaning is platform-run) is not therefore
   * everybody's — it still takes a membership row or an admin.
   */
  private async assertRunsProvider(providerId: string | null, actor: { userId: string; isStaff: boolean }) {
    if (actor.isStaff) return;
    if (!providerId) throw new ForbiddenException("You don't run this business.");

    const rows = await this.rest<Array<{ admin_user_id: string | null }>>(
      `providers?id=eq.${encodeURIComponent(providerId)}&select=admin_user_id&limit=1`,
    );
    if (rows?.[0]?.admin_user_id && String(rows[0].admin_user_id) === String(actor.userId)) return;

    const members = await this.rest<Array<{ id: string }>>(
      `provider_members?provider_id=eq.${encodeURIComponent(providerId)}&user_id=eq.${encodeURIComponent(actor.userId)}&select=id&limit=1`,
    );
    if (!members?.length) throw new ForbiddenException("You don't run this business.");
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
    resource: { hours?: unknown },
  ): Promise<unknown> {
    const own = this.scheduleFromResourceHours(resource?.hours);
    if (own) return own;

    // The beach used to have a branch here that read a court's own
    // `booking_settings` and hour columns. Both moved onto the calendar row
    // above: `booking_settings` was null for every court in production, and
    // the hours are now authored on the resource and mirrored DOWN to the
    // court, so reading them back up was reading our own echo.
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
