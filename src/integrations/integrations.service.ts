import { BadRequestException, Injectable, Logger, NotFoundException, ServiceUnavailableException } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { randomBytes } from "node:crypto";
import * as QRCode from "qrcode";
import { SessionService } from "../auth/session.service";
import type {
  CleaningSubscriptionDto,
  FoodSubscriptionDto,
  ProvisionSubscriptionDto,
  ProvisionSubscriptionResponse,
} from "./dto/provision-subscription.dto";
import type { AccessQrRequestDto, AccessQrResponse } from "./dto/access-qr.dto";
import type {
  BookingsRequestDto,
  BookingsResponse,
  IntegrationBooking,
  IntegrationServiceKey,
} from "./dto/bookings.dto";
import type {
  CreateCleaningBookingDto,
  CreateCleaningBookingResponse,
} from "./dto/create-cleaning-booking.dto";

/**
 * Builders Node → ProsperaSub subscription mirror.
 *
 * Public entry: `provisionSubscription()` — upserts the customer by email and
 * creates the food/cleaning subscription rows they asked for. Both legs are
 * created as `status=active`, `payment_status=paid`, `payment_method=manual`
 * so they surface to providers as live-revenue rows immediately (Builders
 * Node collected payment on their side; we're just mirroring the grant).
 *
 * Idempotent by `external_ref`: if a request with the same ref lands twice,
 * the second call returns the same subscription IDs instead of creating
 * duplicates. Implementation uses `payment_reference = "builders-node:<ref>"`
 * as the lookup key so no schema change was needed on our end.
 *
 * Never partially rolls back — the user upsert always sticks, and each leg
 * (food, cleaning) independently succeeds or emits a `warning` in the
 * response. Callers use the returned IDs + warnings to decide what to retry.
 */
@Injectable()
export class IntegrationsService {
  private readonly logger = new Logger(IntegrationsService.name);

  constructor(
    private readonly config: ConfigService,
    private readonly sessions: SessionService,
  ) {}

  async provisionSubscription(body: ProvisionSubscriptionDto): Promise<ProvisionSubscriptionResponse> {
    if (!body.food && !body.cleaning) {
      throw new BadRequestException("Provide at least one of `food` or `cleaning`");
    }

    const rest = this.restBase();
    if (!rest) {
      throw new ServiceUnavailableException("Supabase is not configured on the server");
    }

    const warnings: string[] = [];

    // ── 1. Customer (upsert by email) ───────────────────────────────────────
    const userId = await this.upsertUserByEmail(body.customer.email, body.customer.name);

    // ── 2. Food subscription (optional) ─────────────────────────────────────
    let foodSubscriptionId: string | null = null;
    if (body.food) {
      try {
        foodSubscriptionId = await this.provisionFoodSubscription(
          userId, body.customer, body.food, body.external_ref,
        );
      } catch (e) {
        const msg = (e as Error).message || "unknown error";
        this.logger.warn(`[integrations] food leg failed: ${msg}`);
        warnings.push(`food: ${msg}`);
      }
    }

    // ── 3. Cleaning subscription (optional) ─────────────────────────────────
    let cleaningSubscriptionId: string | null = null;
    if (body.cleaning) {
      try {
        cleaningSubscriptionId = await this.provisionCleaningSubscription(
          userId, body.customer, body.cleaning, body.external_ref,
        );
      } catch (e) {
        const msg = (e as Error).message || "unknown error";
        this.logger.warn(`[integrations] cleaning leg failed: ${msg}`);
        warnings.push(`cleaning: ${msg}`);
      }
    }

    return {
      user_id: userId,
      food_subscription_id: foodSubscriptionId,
      cleaning_subscription_id: cleaningSubscriptionId,
      warnings,
    };
  }

  /**
   * Mint a short-lived signed access token + a rendered QR-code SVG for a
   * user identified by email or user_id. Builders Node embeds the SVG on
   * their profile page; anyone (staff, provider, kiosk) scans it and lands
   * on `/verify?token=…` which returns GREEN/RED against ALL the user's
   * ProsperaSub subscriptions.
   *
   * User resolution: prefer `user_id` if present, else look up by email.
   * Never creates a user here — this endpoint is for showing status of an
   * EXISTING user. If Builders Node needs to onboard a new customer they
   * should call POST /integrations/builders-node/subscription first (which
   * upserts) and then use the returned `user_id` here.
   */
  async mintAccessQr(body: AccessQrRequestDto): Promise<AccessQrResponse> {
    if (!body.email && !body.user_id) {
      throw new BadRequestException("Provide `email` or `user_id`");
    }

    const rest = this.restBase();
    if (!rest) {
      throw new ServiceUnavailableException("Supabase is not configured on the server");
    }

    // ── 1. Resolve user_id ────────────────────────────────────────────────
    let userId = body.user_id ?? null;
    if (!userId) {
      const email = (body.email as string).trim().toLowerCase();
      const rows = await this.rest<Array<{ id: string }>>(
        `users?select=id&email=eq.${encodeURIComponent(email)}&limit=1`,
      );
      userId = rows?.[0]?.id ?? null;
      if (!userId) {
        throw new NotFoundException(`No ProsperaSub user for email ${email}`);
      }
    } else {
      // Sanity-check the id exists — otherwise the QR mints fine but the
      // scanner would just get "User not found" with no explanation.
      const rows = await this.rest<Array<{ id: string }>>(
        `users?select=id&id=eq.${encodeURIComponent(userId)}&limit=1`,
      );
      if (!rows?.[0]) throw new NotFoundException(`user_id ${userId} not found`);
    }

    // ── 2. Mint the same verify-token our own QR uses ──────────────────────
    const ttl = Math.min(3600, Math.max(30,
      body.ttl_seconds ?? Number(this.config.get("VERIFY_TOKEN_TTL_SECONDS") ?? 300),
    ));
    const { token, expiresIn } = this.sessions.createVerifyToken(userId, ttl);

    // ── 3. Compose the URL scanners will land on ───────────────────────────
    const publicUrl = (this.config.get<string>("PUBLIC_APP_URL") ?? "https://prosperasub.com").replace(/\/$/, "");
    const verifyUrl = `${publicUrl}/verify?token=${encodeURIComponent(token)}`;

    // ── 4. Render the QR to SVG server-side ────────────────────────────────
    // qrcode.toString('svg', {...}) returns a self-contained <svg> string that
    // Builders Node can drop into their HTML with no runtime deps.
    const qrSvg = await QRCode.toString(verifyUrl, {
      type: "svg",
      errorCorrectionLevel: "M",
      margin: 1,
      width: 320,
      color: { dark: "#000000", light: "#FFFFFF" },
    });
    const qrDataUrl = `data:image/svg+xml;base64,${Buffer.from(qrSvg).toString("base64")}`;

    return {
      user_id: userId,
      token,
      verify_url: verifyUrl,
      qr_svg: qrSvg,
      qr_data_url: qrDataUrl,
      expires_in: expiresIn,
    };
  }

  /**
   * List every scheduled event for a user across ProsperaSub services,
   * normalised to a common shape. Returns cleaning visits (one row per
   * booked slot), beach court reservations, rental periods, and food
   * subscriptions (one row per subscription — its active window).
   *
   * Bounded by `from`/`to` (defaults today → +90 days HN) so a response is
   * always finite regardless of how much history the user has. Optional
   * `service` filter restricts to one type.
   */
  async listBookings(body: BookingsRequestDto): Promise<BookingsResponse> {
    if (!body.email && !body.user_id) {
      throw new BadRequestException("Provide `email` or `user_id`");
    }

    const rest = this.restBase();
    if (!rest) {
      throw new ServiceUnavailableException("Supabase is not configured on the server");
    }

    // Resolve user
    let userId = body.user_id ?? null;
    if (!userId) {
      const email = (body.email as string).trim().toLowerCase();
      const rows = await this.rest<Array<{ id: string }>>(
        `users?select=id&email=eq.${encodeURIComponent(email)}&limit=1`,
      );
      userId = rows?.[0]?.id ?? null;
      if (!userId) throw new NotFoundException(`No ProsperaSub user for email ${email}`);
    }

    // Date window
    const from = body.from || this.todayHN();
    const to = body.to || this.addDaysISO(from, 90);
    if (to < from) throw new BadRequestException("`to` must be >= `from`");

    // Fan out — each service is independent; failures on one leg surface as
    // empty arrays, not a whole-response 500.
    const only = body.service as IntegrationServiceKey | undefined;
    const [cleaning, food, beach, rental] = await Promise.all([
      !only || only === "cleaning" ? this.listCleaningBookings(userId, from, to).catch(() => []) : Promise.resolve([]),
      !only || only === "food"     ? this.listFoodSubscriptions(userId, from, to).catch(() => []) : Promise.resolve([]),
      !only || only === "beach"    ? this.listBeachBookings(userId, from, to).catch(() => [])    : Promise.resolve([]),
      !only || only === "rental"   ? this.listRentalBookings(userId, from, to).catch(() => [])   : Promise.resolve([]),
    ]);

    const bookings = [...cleaning, ...food, ...beach, ...rental]
      .sort((a, b) => a.start_at.localeCompare(b.start_at));

    return { user_id: userId, from, to, bookings };
  }

  /**
   * Book one cleaning visit for a user with an active paid subscription.
   * Called by Builders Node's UI after their customer picks date + time.
   *
   * Contract:
   *  - User must have at least one paid+active cleaning subscription. If
   *    they have several, `subscription_id` picks one; otherwise we take
   *    the first one (ordered by most recent).
   *  - `date` must be today HN or later (no back-dating from partners).
   *  - The visit slot is created on-demand if none exists at the exact
   *    date/start/end combo — same `ensureCleaningSlot` behaviour as our
   *    admin `NewCleaningBookingDialog`.
   *  - Bumps `cleaning_available_slots.current_bookings` so the slot's
   *    capacity accounting stays honest (a hand-added booking counts).
   *  - Google Calendar sync is marked `pending`; the daily calendar cron
   *    (or an admin's manual Sync) picks it up.
   */
  async createCleaningBooking(body: CreateCleaningBookingDto): Promise<CreateCleaningBookingResponse> {
    if (!body.email && !body.user_id) {
      throw new BadRequestException("Provide `email` or `user_id`");
    }

    const rest = this.restBase();
    if (!rest) {
      throw new ServiceUnavailableException("Supabase is not configured on the server");
    }

    // 1. Resolve user
    let userId = body.user_id ?? null;
    if (!userId) {
      const email = (body.email as string).trim().toLowerCase();
      const rows = await this.rest<Array<{ id: string }>>(
        `users?select=id&email=eq.${encodeURIComponent(email)}&limit=1`,
      );
      userId = rows?.[0]?.id ?? null;
      if (!userId) throw new NotFoundException(`No ProsperaSub user for email ${email}`);
    }

    // 2. Find an eligible subscription — paid + active/pending_schedule.
    //    Rejecting free bookings is the whole point of this filter: without
    //    it, anyone with a valid partner token could book cleanings for a
    //    user who hasn't paid.
    let subQuery = `cleaning_subscriptions?select=id,user_id,package_id,payment_status,subscription_status,apartment_note` +
      `&user_id=eq.${userId}&payment_status=eq.paid` +
      `&subscription_status=in.(active,pending_schedule)` +
      `&order=created_at.desc`;
    if (body.subscription_id) {
      subQuery += `&id=eq.${body.subscription_id}`;
    }
    const subs = await this.rest<Array<{
      id: string; user_id: string; package_id: string | null;
      apartment_note: string | null;
    }>>(subQuery);
    const sub = (subs ?? [])[0];
    if (!sub) {
      throw new BadRequestException(
        body.subscription_id
          ? `No paid+active cleaning subscription matches subscription_id ${body.subscription_id}`
          : "User has no paid+active cleaning subscription",
      );
    }

    // 3. Validate the date is today or later (HN).
    if (body.date < this.todayHN()) {
      throw new BadRequestException("`date` must be today or in the future");
    }

    // 4. ensureCleaningSlot: look up by exact date + start + end, seed if missing.
    const start = `${body.start_time}:00`;
    const end = `${body.end_time || body.start_time}:00`;
    const existing = await this.rest<Array<{
      id: string; current_bookings: number | null; max_bookings: number | null; is_active: boolean;
    }>>(
      `cleaning_available_slots?select=id,current_bookings,max_bookings,is_active` +
        `&date=eq.${body.date}&start_time=eq.${start}&end_time=eq.${end}&limit=1`,
    );
    let slot = existing?.[0] ?? null;
    if (!slot) {
      const seededRows = await this.insertReturning<{
        id: string; current_bookings: number | null; max_bookings: number | null; is_active: boolean;
      }>("cleaning_available_slots", {
        // Match the id shape used elsewhere in the admin flow so cross-team
        // debugging tools can eyeball it (`slot-YYYY-MM-DD-HHMM`).
        id: `slot-${body.date}-${body.start_time.replace(":", "")}`,
        date: body.date,
        start_time: start,
        end_time: end,
        max_bookings: 3,
        current_bookings: 0,
        is_active: true,
      });
      slot = seededRows[0];
    }
    if (!slot.is_active) {
      throw new BadRequestException("That slot is not accepting bookings");
    }
    if ((slot.current_bookings ?? 0) >= (slot.max_bookings ?? 0)) {
      throw new BadRequestException("That slot is full — pick another time");
    }

    // 5. Insert the booking, then bump the slot's counter.
    const bookingRows = await this.insertReturning<{ id: string }>("cleaning_bookings", {
      user_id: userId,
      subscription_id: sub.id,
      cleaning_subscription_id: sub.id,
      slot_id: slot.id,
      status: "booked",
      reservation_type: "booking_reserved",
      source: "builders_node",
      notes: (body.notes?.trim() || sub.apartment_note || null),
      google_calendar_sync_status: "pending",
    });
    const bookingId = bookingRows[0]?.id;
    if (!bookingId) throw new Error("cleaning_bookings insert returned no id");

    // 6. Bump slot capacity (single PATCH — no need to re-select before the +1
    //    since we just fetched current_bookings and no other writer holds it).
    await this.patch(`cleaning_available_slots?id=eq.${encodeURIComponent(slot.id)}`, {
      current_bookings: (slot.current_bookings ?? 0) + 1,
      updated_at: new Date().toISOString(),
    });

    return {
      booking_id: bookingId,
      subscription_id: sub.id,
      slot_id: slot.id,
      date: body.date,
      start_time: body.start_time,
      end_time: body.end_time || body.start_time,
      status: "booked",
    };
  }

  // ─── Per-service aggregators ───────────────────────────────────────────────

  private async listCleaningBookings(userId: string, from: string, to: string): Promise<IntegrationBooking[]> {
    // Subs the user owns (payment status is a UI concern; here we just list
    // every scheduled visit regardless of paid/unpaid so the partner can
    // show unpaid-pending bookings too).
    const subs = await this.rest<Array<{ id: string; package_id: string | null }>>(
      `cleaning_subscriptions?select=id,package_id&user_id=eq.${userId}`,
    );
    const subIds = (subs ?? []).map((s) => s.id);
    if (subIds.length === 0) return [];

    const bookings = await this.rest<Array<{
      id: string; subscription_id: string; status: string; notes: string | null; location: string | null;
      cleaning_available_slots: { date: string; start_time: string; end_time: string | null } | null;
    }>>(
      `cleaning_bookings?select=id,subscription_id,status,notes,location,` +
        `cleaning_available_slots!inner(date,start_time,end_time)` +
        `&subscription_id=in.(${subIds.join(",")})` +
        `&cleaning_available_slots.date=gte.${from}&cleaning_available_slots.date=lte.${to}` +
        `&order=cleaning_available_slots(date).asc`,
    );
    const rows = bookings ?? [];
    if (rows.length === 0) return [];

    // Batch plan + provider name lookups
    const pkgIds = Array.from(new Set(
      (subs ?? []).filter((s) => rows.some((b) => b.subscription_id === s.id))
        .map((s) => s.package_id).filter((id): id is string => !!id),
    ));
    const [pkgs, subMap] = await Promise.all([
      pkgIds.length
        ? this.rest<Array<{ id: string; name: string; provider_id: string | null }>>(
            `cleaning_packages?select=id,name,provider_id&id=in.(${pkgIds.join(",")})`)
        : Promise.resolve([] as Array<{ id: string; name: string; provider_id: string | null }>),
      Promise.resolve(new Map((subs ?? []).map((s) => [s.id, s.package_id]))),
    ]);
    const pkgMap = new Map((pkgs ?? []).map((p) => [p.id, p]));
    const providerIds = Array.from(new Set((pkgs ?? []).map((p) => p.provider_id).filter((id): id is string => !!id)));
    const providers = providerIds.length
      ? await this.rest<Array<{ id: string; name: string }>>(
          `cleaning_providers?select=id,name&id=in.(${providerIds.join(",")})`)
      : [];
    const providerMap = new Map((providers ?? []).map((p) => [p.id, p.name]));

    return rows.map((r) => {
      const slot = r.cleaning_available_slots;
      const pkgId = subMap.get(r.subscription_id) ?? null;
      const pkg = pkgId ? pkgMap.get(pkgId) : null;
      const startAt = slot?.date && slot?.start_time
        ? this.toHNOffsetISO(slot.date, slot.start_time)
        : `${slot?.date ?? from}T00:00:00-06:00`;
      const endAt = slot?.date && slot?.end_time
        ? this.toHNOffsetISO(slot.date, slot.end_time)
        : null;
      return {
        service: "cleaning",
        id: r.id,
        plan_name: pkg?.name ?? null,
        provider_name: pkg?.provider_id ? providerMap.get(pkg.provider_id) ?? null : null,
        start_at: startAt,
        end_at: endAt,
        status: r.status,
        notes: r.notes ?? r.location ?? null,
      };
    });
  }

  private async listFoodSubscriptions(userId: string, from: string, to: string): Promise<IntegrationBooking[]> {
    // Food is a date-range product — return one row per subscription whose
    // window overlaps [from, to]. Partners can display "Meal plan active
    // until Aug 20" without pretending each delivery is a discrete booking.
    const subs = await this.rest<Array<{
      id: string; meal_plan_id: string | null; provider_id: string | null;
      started_at: string; end_date: string; status: string;
      delivery_address: string | null; notes: string | null;
    }>>(
      `food_subscriptions?select=id,meal_plan_id,provider_id,started_at,end_date,status,delivery_address,notes` +
        `&user_id=eq.${userId}` +
        `&started_at=lte.${to}&end_date=gte.${from}` +
        `&order=started_at.asc`,
    );
    const rows = subs ?? [];
    if (rows.length === 0) return [];

    const planIds = Array.from(new Set(rows.map((r) => r.meal_plan_id).filter((id): id is string => !!id)));
    const providerIds = Array.from(new Set(rows.map((r) => r.provider_id).filter((id): id is string => !!id)));
    const [plans, providers] = await Promise.all([
      planIds.length
        ? this.rest<Array<{ id: string; name: string }>>(`food_meal_plans?select=id,name&id=in.(${planIds.join(",")})`)
        : Promise.resolve([] as Array<{ id: string; name: string }>),
      providerIds.length
        ? this.rest<Array<{ id: string; name: string }>>(`food_providers?select=id,name&id=in.(${providerIds.join(",")})`)
        : Promise.resolve([] as Array<{ id: string; name: string }>),
    ]);
    const planMap = new Map((plans ?? []).map((p) => [p.id, p.name]));
    const providerMap = new Map((providers ?? []).map((p) => [p.id, p.name]));

    return rows.map((r) => ({
      service: "food",
      id: r.id,
      plan_name: r.meal_plan_id ? planMap.get(r.meal_plan_id) ?? null : null,
      provider_name: r.provider_id ? providerMap.get(r.provider_id) ?? null : null,
      start_at: this.toHNOffsetISO(r.started_at, "00:00"),
      end_at: this.toHNOffsetISO(r.end_date, "23:59"),
      status: r.status,
      notes: r.notes ?? r.delivery_address ?? null,
    }));
  }

  private async listBeachBookings(userId: string, from: string, to: string): Promise<IntegrationBooking[]> {
    // Legacy court bookings (beach_club_court_bookings) — book by user_id.
    // The DDD engine's `bookings` table also holds beach court reservations
    // with subject_ref="user:<id>"; include those too so the response covers
    // both pre- and post-cutover data.
    const [legacy, ddd] = await Promise.all([
      this.rest<Array<{
        id: string; court_id: string | null; date: string;
        start_time: string; end_time: string | null; status: string; notes: string | null;
      }>>(
        `beach_club_court_bookings?select=id,court_id,date,start_time,end_time,status,notes` +
          `&user_id=eq.${userId}&date=gte.${from}&date=lte.${to}&order=date.asc,start_time.asc`,
      ),
      this.rest<Array<{
        id: string; resource_id: string; start_at: string; end_at: string;
        status: string; notes: string | null;
      }>>(
        `bookings?select=id,resource_id,start_at,end_at,status,notes` +
          `&subject_ref=eq.user:${userId}` +
          `&start_at=gte.${from}T00:00:00&start_at=lte.${to}T23:59:59` +
          `&order=start_at.asc`,
      ),
    ]);

    // Court name lookup for both sources
    const legacyCourtIds = Array.from(new Set((legacy ?? []).map((r) => r.court_id).filter((id): id is string => !!id)));
    const dddResourceIds = Array.from(new Set((ddd ?? []).map((r) => r.resource_id)));

    const [courts, resources] = await Promise.all([
      legacyCourtIds.length
        ? this.rest<Array<{ id: string; name: string }>>(`beach_club_courts?select=id,name&id=in.(${legacyCourtIds.join(",")})`)
        : Promise.resolve([] as Array<{ id: string; name: string }>),
      dddResourceIds.length
        ? this.rest<Array<{ id: string; name: string; source_resource_id: string | null }>>(
            `bookable_resources?select=id,name,source_resource_id&id=in.(${dddResourceIds.join(",")})&source_service_key=eq.beach`)
        : Promise.resolve([] as Array<{ id: string; name: string; source_resource_id: string | null }>),
    ]);
    const courtMap = new Map((courts ?? []).map((c) => [c.id, c.name]));
    const resourceMap = new Map((resources ?? []).map((r) => [r.id, r.name]));

    const fromLegacy: IntegrationBooking[] = (legacy ?? []).map((r) => ({
      service: "beach",
      id: r.id,
      plan_name: r.court_id ? courtMap.get(r.court_id) ?? null : null,
      provider_name: "Beach Club",
      start_at: this.toHNOffsetISO(r.date, r.start_time),
      end_at: r.end_time ? this.toHNOffsetISO(r.date, r.end_time) : null,
      status: r.status,
      notes: r.notes,
    }));

    // Filter DDD rows to beach only — subject_ref queries are user-scoped
    // but resource_id could theoretically be non-beach; the resource lookup
    // above already scoped to source_service_key=beach so we drop unknowns.
    const fromDdd: IntegrationBooking[] = (ddd ?? [])
      .filter((r) => resourceMap.has(r.resource_id))
      .map((r) => ({
        service: "beach",
        id: r.id,
        plan_name: resourceMap.get(r.resource_id) ?? null,
        provider_name: "Beach Club",
        start_at: this.dateToHNOffsetISO(r.start_at),
        end_at: this.dateToHNOffsetISO(r.end_at),
        status: r.status,
        notes: r.notes,
      }));

    return [...fromLegacy, ...fromDdd];
  }

  private async listRentalBookings(userId: string, from: string, to: string): Promise<IntegrationBooking[]> {
    const rows = await this.rest<Array<{
      id: string; vehicle_id: string | null;
      start_date: string; end_date: string;
      status: string; notes: string | null; delivery_address: string | null;
    }>>(
      `rental_bookings?select=id,vehicle_id,start_date,end_date,status,notes,delivery_address` +
        `&user_id=eq.${userId}` +
        `&start_date=lte.${to}&end_date=gte.${from}&order=start_date.asc`,
    );
    const bookings = rows ?? [];
    if (bookings.length === 0) return [];

    const vehicleIds = Array.from(new Set(bookings.map((r) => r.vehicle_id).filter((id): id is string => !!id)));
    const vehicles = vehicleIds.length
      ? await this.rest<Array<{ id: string; name: string; provider_id: string | null }>>(
          `rental_vehicles?select=id,name,provider_id&id=in.(${vehicleIds.join(",")})`)
      : [];
    const vehicleMap = new Map((vehicles ?? []).map((v) => [v.id, v]));
    const providerIds = Array.from(new Set((vehicles ?? []).map((v) => v.provider_id).filter((id): id is string => !!id)));
    const providers = providerIds.length
      ? await this.rest<Array<{ id: string; name: string }>>(
          `rental_providers?select=id,name&id=in.(${providerIds.join(",")})`)
      : [];
    const providerMap = new Map((providers ?? []).map((p) => [p.id, p.name]));

    return bookings.map((r) => {
      const vehicle = r.vehicle_id ? vehicleMap.get(r.vehicle_id) : null;
      return {
        service: "rental",
        id: r.id,
        plan_name: vehicle?.name ?? null,
        provider_name: vehicle?.provider_id ? providerMap.get(vehicle.provider_id) ?? null : null,
        start_at: this.toHNOffsetISO(r.start_date, "00:00"),
        end_at: this.toHNOffsetISO(r.end_date, "23:59"),
        status: r.status,
        notes: r.notes ?? r.delivery_address ?? null,
      };
    });
  }

  // ─── User upsert ───────────────────────────────────────────────────────────

  private async upsertUserByEmail(email: string, name: string | undefined): Promise<string> {
    const normalized = email.trim().toLowerCase();

    const existing = await this.rest<Array<{ id: string }>>(
      `users?select=id&email=eq.${encodeURIComponent(normalized)}&limit=1`,
    );
    if (existing && existing[0]?.id) return existing[0].id;

    // Not found → create via the same signup RPC the app uses. The password is
    // a random placeholder; Builders Node users don't log in here with a
    // password (they'll use Google OAuth or password-reset if they ever do).
    const password = randomBytes(24).toString("base64url");
    try {
      const rpc = await this.rpc<{ id: string } | null>("auth_signup_user", {
        p_email: normalized,
        p_name: (name || "").trim(),
        p_password: password,
      });
      if (rpc?.id) return rpc.id;
    } catch (e) {
      // If the RPC reports the row already exists (race between check + insert),
      // read it back and use that id. Any other error propagates.
      const msg = (e as Error).message || "";
      if (msg.toLowerCase().includes("conflict") || msg.toLowerCase().includes("already exists")) {
        const again = await this.rest<Array<{ id: string }>>(
          `users?select=id&email=eq.${encodeURIComponent(normalized)}&limit=1`,
        );
        if (again && again[0]?.id) return again[0].id;
      }
      throw new BadRequestException(`Could not create user for ${normalized}: ${msg}`);
    }
    throw new BadRequestException(`Could not resolve user for ${normalized}`);
  }

  // ─── Food subscription ─────────────────────────────────────────────────────

  private async provisionFoodSubscription(
    userId: string,
    customer: ProvisionSubscriptionDto["customer"],
    plan: FoodSubscriptionDto,
    externalRef: string | undefined,
  ): Promise<string> {
    // Idempotency: same external_ref + same meal plan for the same user means
    // "already provisioned" — return the existing id rather than duplicating.
    const paymentRef = externalRef ? `builders-node:${externalRef}` : null;
    if (paymentRef) {
      const existing = await this.rest<Array<{ id: string }>>(
        `food_subscriptions?select=id&user_id=eq.${userId}&meal_plan_id=eq.${plan.meal_plan_id}` +
          `&payment_reference=eq.${encodeURIComponent(paymentRef)}&limit=1`,
      );
      if (existing && existing[0]?.id) return existing[0].id;
    }

    // Validate the plan exists + belongs to a real provider before we insert —
    // Postgres would reject a bad meal_plan_id with a foreign-key error that's
    // harder to explain than "meal plan not found".
    const plans = await this.rest<Array<{ id: string; provider_id: string; weekly_price_cents: number }>>(
      `food_meal_plans?select=id,provider_id,weekly_price_cents&id=eq.${plan.meal_plan_id}&limit=1`,
    );
    const planRow = plans?.[0];
    if (!planRow) throw new Error(`meal_plan_id ${plan.meal_plan_id} not found`);

    const startedAt = plan.started_at || this.todayHN();
    const endDate = this.addDaysISO(startedAt, Math.max(plan.weeks, 1) * 7 - 1);
    const payload: Record<string, unknown> = {
      user_id: userId,
      provider_id: planRow.provider_id,
      meal_plan_id: plan.meal_plan_id,
      weekly_price_cents: planRow.weekly_price_cents,
      commitment_weeks: plan.weeks,
      started_at: startedAt,
      end_date: endDate,
      status: "active",
      payment_status: "paid",
      payment_method: "manual",
      periods_paid: 1,
      customer_name: (customer.name || "").trim() || null,
      customer_whatsapp: (customer.whatsapp || "").trim() || null,
      residence: plan.residence?.trim() || null,
      delivery_address: plan.delivery_address?.trim() || null,
      notes: plan.notes?.trim() || "Provisioned by Builders Node",
      payment_reference: paymentRef,
    };

    const rows = await this.insertReturning<{ id: string }>("food_subscriptions", payload);
    if (!rows[0]?.id) throw new Error("food_subscriptions insert returned no id");
    return rows[0].id;
  }

  // ─── Cleaning subscription ─────────────────────────────────────────────────

  private async provisionCleaningSubscription(
    userId: string,
    _customer: ProvisionSubscriptionDto["customer"],
    plan: CleaningSubscriptionDto,
    externalRef: string | undefined,
  ): Promise<string> {
    const paymentRef = externalRef ? `builders-node:${externalRef}` : null;
    if (paymentRef) {
      const existing = await this.rest<Array<{ id: string }>>(
        `cleaning_subscriptions?select=id&user_id=eq.${userId}&package_id=eq.${plan.package_id}` +
          `&payment_reference=eq.${encodeURIComponent(paymentRef)}&limit=1`,
      );
      if (existing && existing[0]?.id) return existing[0].id;
    }

    // Look up the package for its monthly price + monthly cleaning count so we
    // can precompute the same fields the public checkout writes.
    const pkgs = await this.rest<Array<{
      id: string; monthly_price_cents: number; cleanings_per_month: number;
    }>>(
      `cleaning_packages?select=id,monthly_price_cents,cleanings_per_month&id=eq.${plan.package_id}&limit=1`,
    );
    const pkg = pkgs?.[0];
    if (!pkg) throw new Error(`package_id ${plan.package_id} not found`);

    const startedAt = plan.started_at || this.todayHN();
    const endDate = this.addMonthsISO(startedAt, plan.months);
    const monthlyCents = Number(pkg.monthly_price_cents) || 0;
    const totalCents = monthlyCents * plan.months;
    const cleaningsIncluded = (Number(pkg.cleanings_per_month) || 0) * plan.months;

    const payload: Record<string, unknown> = {
      user_id: userId,
      package_id: plan.package_id,
      start_date: startedAt,
      end_date: endDate,
      service_start_date: startedAt,
      service_end_date: endDate,
      paid_until: endDate,
      billing_period_months: plan.months,
      monthly_price_cents: monthlyCents,
      total_price_cents: totalCents,
      cleanings_remaining: cleaningsIncluded,
      payment_status: "paid",
      payment_method: "manual",
      payment_reference: paymentRef,
      // Sub goes straight to pending_schedule + active so it shows up on the
      // provider's Bookings tab. The customer still has to pick their weekly
      // slot via /my-subscriptions before any cleanings actually get booked.
      subscription_status: "pending_schedule",
      is_active: true,
      apartment_note: plan.apartment_note?.trim() || null,
      cleaner_hint: plan.cleaner_hint?.trim() || null,
      admin_notes: "Provisioned by Builders Node",
    };

    const rows = await this.insertReturning<{ id: string }>("cleaning_subscriptions", payload);
    if (!rows[0]?.id) throw new Error("cleaning_subscriptions insert returned no id");
    return rows[0].id;
  }

  // ─── PostgREST + RPC helpers ───────────────────────────────────────────────

  private restBase(): { base: string; key: string } | null {
    const base = this.config.get<string>("SUPABASE_URL")?.replace(/\/$/, "");
    const key =
      this.config.get<string>("SUPABASE_SERVICE_ROLE_KEY") || this.config.get<string>("SUPABASE_ANON_KEY");
    if (!base || !key) return null;
    return { base, key };
  }

  private async rest<T>(path: string): Promise<T | null> {
    const cfg = this.restBase();
    if (!cfg) return null;
    const res = await fetch(`${cfg.base}/rest/v1/${path}`, {
      headers: { apikey: cfg.key, Authorization: `Bearer ${cfg.key}` },
    });
    if (!res.ok) {
      this.logger.warn(`[integrations.rest] ${path} → ${res.status}`);
      return null;
    }
    return (await res.json()) as T;
  }

  private async insertReturning<T>(table: string, body: Record<string, unknown>): Promise<T[]> {
    const cfg = this.restBase();
    if (!cfg) throw new Error("Supabase is not configured");
    const res = await fetch(`${cfg.base}/rest/v1/${table}`, {
      method: "POST",
      headers: {
        apikey: cfg.key,
        Authorization: `Bearer ${cfg.key}`,
        "Content-Type": "application/json",
        Prefer: "return=representation",
      },
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new Error(`${table} insert failed (${res.status}): ${text || "no body"}`);
    }
    return (await res.json()) as T[];
  }

  private async patch(path: string, body: Record<string, unknown>): Promise<void> {
    const cfg = this.restBase();
    if (!cfg) throw new Error("Supabase is not configured");
    const res = await fetch(`${cfg.base}/rest/v1/${path}`, {
      method: "PATCH",
      headers: {
        apikey: cfg.key,
        Authorization: `Bearer ${cfg.key}`,
        "Content-Type": "application/json",
        Prefer: "return=minimal",
      },
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new Error(`PATCH ${path} failed (${res.status}): ${text || "no body"}`);
    }
  }

  private async rpc<T>(name: string, args: Record<string, unknown>): Promise<T | null> {
    const cfg = this.restBase();
    if (!cfg) throw new Error("Supabase is not configured");
    const res = await fetch(`${cfg.base}/rest/v1/rpc/${name}`, {
      method: "POST",
      headers: {
        apikey: cfg.key,
        Authorization: `Bearer ${cfg.key}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(args),
    });
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new Error(`RPC ${name} failed (${res.status}): ${text || "no body"}`);
    }
    return (await res.json()) as T;
  }

  // ─── Time helpers (Honduras local) ─────────────────────────────────────────

  private todayHN(): string {
    // Honduras is UTC-6 year-round (no DST) — shift UTC by six hours to land
    // on today HN, then slice to YYYY-MM-DD.
    const now = new Date(Date.now() - 6 * 60 * 60 * 1000);
    return now.toISOString().slice(0, 10);
  }

  private addDaysISO(isoDate: string, days: number): string {
    const d = new Date(`${isoDate}T00:00:00Z`);
    d.setUTCDate(d.getUTCDate() + days);
    return d.toISOString().slice(0, 10);
  }

  private addMonthsISO(isoDate: string, months: number): string {
    const d = new Date(`${isoDate}T00:00:00Z`);
    d.setUTCMonth(d.getUTCMonth() + months);
    return d.toISOString().slice(0, 10);
  }

  /** YYYY-MM-DD + HH:MM → "YYYY-MM-DDTHH:MM:00-06:00" (Honduras, no DST). */
  private toHNOffsetISO(dateISO: string, hhmm: string): string {
    const time = String(hhmm).slice(0, 5);
    return `${dateISO}T${time}:00-06:00`;
  }

  /** Postgres timestamp / ISO → HN-offset ISO, safe for missing tz. */
  private dateToHNOffsetISO(value: string): string {
    // Postgres returns "YYYY-MM-DDTHH:MM:SS(.mmm)?(+00:00)?" — normalise.
    const d = new Date(value);
    if (isNaN(d.getTime())) return value;
    const shifted = new Date(d.getTime() - 6 * 60 * 60 * 1000);
    const yyyy = shifted.getUTCFullYear();
    const mm = String(shifted.getUTCMonth() + 1).padStart(2, "0");
    const dd = String(shifted.getUTCDate()).padStart(2, "0");
    const HH = String(shifted.getUTCHours()).padStart(2, "0");
    const MI = String(shifted.getUTCMinutes()).padStart(2, "0");
    const SS = String(shifted.getUTCSeconds()).padStart(2, "0");
    return `${yyyy}-${mm}-${dd}T${HH}:${MI}:${SS}-06:00`;
  }
}
