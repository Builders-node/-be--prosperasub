import {
  BadRequestException, ConflictException, ForbiddenException, Injectable, Logger, NotFoundException,
} from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { BlinkService } from "../payments/blink.service";
import { PayPalService } from "../payments/paypal.service";
import { calcRentalPrice, extraCost, rentalDaysBetween, surchargeCentsFor } from "./rental-pricing";

/**
 * Server-side car-rental booking.
 *
 * Until now the browser wrote `rental_bookings` itself with the anon key —
 * every price column included — and marked its own row paid after polling.
 * That was the last direct path money took past the API. This service is the
 * replacement: the caller names WHAT they want (a car, dates, add-on ids) and
 * the server decides what it costs, from the same rows the browser showed.
 *
 * The exclusion constraint on `rental_bookings` stays the real guarantee that
 * one car is not sold twice; this just moves whose INSERT trips it.
 *
 * RLS on `rental_bookings` is still permissive because the browser keeps a
 * fallback write path until this API is deployed and proven. Tightening it is
 * the step AFTER the fallback is removed — not before, or car booking dies the
 * moment the frontend ships ahead of the backend.
 */

export interface CreateRentalInput {
  vehicleId: string;
  startDate: string;
  endDate: string;
  insuranceTierId?: string | null;
  extraIds?: string[];
  deliveryZoneId?: string | null;
  paymentMethod: string;
  customerName?: string | null;
  customerWhatsapp?: string | null;
  deliveryAddress?: string | null;
  deliveryNotes?: string | null;
}

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

/** Today as lived in Honduras, whatever timezone the server runs in. */
function todayHN(): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/Tegucigalpa", year: "numeric", month: "2-digit", day: "2-digit",
  }).format(new Date());
}

@Injectable()
export class RentalsService {
  private readonly logger = new Logger(RentalsService.name);

  constructor(
    private readonly config: ConfigService,
    private readonly blink: BlinkService,
    private readonly paypal: PayPalService,
  ) {}

  async create(input: CreateRentalInput, userId: string) {
    const { startDate, endDate } = input;
    if (!ISO_DATE.test(startDate) || !ISO_DATE.test(endDate) || endDate < startDate || startDate < todayHN()) {
      throw new BadRequestException("invalid_dates");
    }

    const vehicle = (await this.rest<Array<Record<string, any>>>(
      `/rental_vehicles?id=eq.${encodeURIComponent(input.vehicleId)}` +
        `&select=id,name,provider_id,status,daily_price_cents,weekly_price_cents,monthly_price_cents&limit=1`,
    ))?.[0];
    if (!vehicle || vehicle.status !== "public") throw new BadRequestException("vehicle_unavailable");

    const days = rentalDaysBetween(startDate, endDate);
    const pricing = calcRentalPrice(vehicle as any, days);
    if (pricing.totalCents <= 0) throw new BadRequestException("vehicle_unavailable");

    /**
     * Add-ons resolve against the OWNING business's own active rows — an id
     * from another company's price sheet, or one the provider has retired, is
     * refused rather than priced.
     */
    const providerId = String(vehicle.provider_id ?? "");
    const addonScope = `&provider_id=eq.${encodeURIComponent(providerId)}&is_active=eq.true`;

    let insurance: Record<string, any> | null = null;
    if (input.insuranceTierId) {
      insurance = (await this.rest<Array<Record<string, any>>>(
        `/rental_insurance_tiers?id=eq.${encodeURIComponent(input.insuranceTierId)}${addonScope}` +
          `&select=id,name,price_per_day_cents&limit=1`,
      ))?.[0] ?? null;
      if (!insurance) throw new BadRequestException("invalid_insurance");
    }

    const extraIds = [...new Set((input.extraIds ?? []).filter(Boolean))];
    let extras: Array<Record<string, any>> = [];
    if (extraIds.length) {
      extras = (await this.rest<Array<Record<string, any>>>(
        `/rental_extras?id=in.(${extraIds.map(encodeURIComponent).join(",")})${addonScope}` +
          `&select=id,name,price_cents,price_type`,
      )) ?? [];
      if (extras.length !== extraIds.length) throw new BadRequestException("invalid_extras");
    }

    let zone: Record<string, any> | null = null;
    if (input.deliveryZoneId) {
      zone = (await this.rest<Array<Record<string, any>>>(
        `/rental_delivery_zones?id=eq.${encodeURIComponent(input.deliveryZoneId)}${addonScope}` +
          `&select=id,name,fee_cents&limit=1`,
      ))?.[0] ?? null;
      if (!zone) throw new BadRequestException("invalid_zone");
    }

    const insuranceCents = insurance ? Number(insurance.price_per_day_cents || 0) * Math.max(1, days) : 0;
    const extrasPriced = extras.map((e) => ({ id: e.id, name: e.name, cents: extraCost(e as any, days) }));
    const extrasCents = extrasPriced.reduce((s, e) => s + e.cents, 0);
    const deliveryFee = Number(zone?.fee_cents ?? 0);
    const baseTotal = pricing.totalCents + insuranceCents + extrasCents + deliveryFee;

    const surcharge = surchargeCentsFor(baseTotal, await this.surchargePct(input.paymentMethod));

    let rows: Array<{ id: string }>;
    try {
      rows = await this.rest<Array<{ id: string }>>("/rental_bookings", {
        method: "POST",
        headers: { Prefer: "return=representation" },
        body: JSON.stringify({
          user_id: userId,
          vehicle_id: vehicle.id,
          start_date: startDate,
          end_date: endDate,
          rental_days: days,
          daily_price_cents: pricing.effectiveDailyRate,
          subtotal_cents: pricing.subtotalCents,
          discount_pct: pricing.discountPct,
          discount_cents: pricing.discountCents,
          insurance_tier_id: insurance?.id ?? null,
          insurance_cents: insuranceCents,
          delivery_zone_id: zone?.id ?? null,
          delivery_fee_cents: deliveryFee,
          extras: extrasPriced,
          extras_cents: extrasCents,
          total_cents: baseTotal,
          surcharge_cents: surcharge,
          customer_name: input.customerName?.trim() || null,
          customer_whatsapp: input.customerWhatsapp?.trim() || null,
          delivery_address: input.deliveryAddress?.trim() || zone?.name || null,
          delivery_notes: input.deliveryNotes?.trim() || null,
          status: "pending",
          payment_status: "pending",
          payment_method: input.paymentMethod,
        }),
      });
    } catch (err) {
      // 23P01 — the overlap constraint refused it: somebody else's booking
      // holds these dates. The one race the pre-read cannot win.
      if (/23P01|exclusion constraint/i.test((err as Error).message)) {
        throw new ConflictException("dates_taken");
      }
      throw err;
    }

    const id = rows?.[0]?.id;
    if (!id) throw new BadRequestException("booking_failed");
    this.logger.log(`[rental] ${id}: ${vehicle.name} ${startDate}→${endDate} ${baseTotal}c (+${surcharge}c fee) for ${userId}`);
    return { id, total_cents: baseTotal, surcharge_cents: surcharge, charged_cents: baseTotal + surcharge };
  }

  /**
   * Confirm a rental once its payment is REAL — the server asks the provider,
   * so a forged reference cannot flip a row to paid. Idempotent: confirming a
   * row already paid answers yes again.
   */
  async confirm(bookingId: string, input: { paymentReference: string; paymentMethod: string }, userId: string) {
    const row = (await this.rest<Array<Record<string, any>>>(
      `/rental_bookings?id=eq.${encodeURIComponent(bookingId)}` +
        `&select=id,user_id,payment_status,status&deleted_at=is.null&limit=1`,
    ))?.[0];
    if (!row) throw new NotFoundException("booking_not_found");
    if (String(row.user_id) !== String(userId)) throw new ForbiddenException("not_your_booking");
    if (row.payment_status === "paid") return { confirmed: true, id: bookingId };

    const ref = String(input.paymentReference || "").trim();
    if (!ref) throw new BadRequestException("payment_reference_required");
    const method = String(input.paymentMethod || "").toLowerCase();

    const paid = await this.checkPaid(method, ref);
    if (!paid) throw new ForbiddenException("payment_not_confirmed");

    await this.rest(`/rental_bookings?id=eq.${encodeURIComponent(bookingId)}`, {
      method: "PATCH",
      headers: { Prefer: "return=minimal" },
      body: JSON.stringify({
        status: "confirmed",
        payment_status: "paid",
        payment_method: method,
        payment_reference: ref,
        updated_at: new Date().toISOString(),
      }),
    });
    this.logger.log(`[rental] ${bookingId}: confirmed via ${method}`);
    return { confirmed: true, id: bookingId };
  }

  private async checkPaid(method: string, ref: string): Promise<boolean> {
    if (method === "lightning" || method === "blink") {
      return (await this.blink.getPaymentStatus(ref)).paid;
    }
    if (method === "onchain") {
      // Expected sats from the invoice-time checkout session, same as the
      // reconcile cron and webhook — an underpaid tx must not confirm.
      const sessions = await this.rest<Array<{ amount_sats: number | null }>>(
        `/payment_checkout_sessions?provider_payment_id=eq.${encodeURIComponent(ref)}` +
          `&select=amount_sats&order=created_at.desc&limit=1`,
      );
      const sats = sessions?.[0]?.amount_sats;
      const expected = typeof sats === "number" && sats > 0 ? sats : undefined;
      return (await this.blink.getOnchainStatus(ref, expected)).paid;
    }
    if (method === "paypal") {
      // captureOrder is idempotent — an already-captured order resolves paid.
      const captured = await this.paypal.captureOrder(ref).catch(() => null);
      if (captured?.paid) return true;
      const order = (await this.paypal.getOrder(ref).catch(() => null)) as { status?: string } | null;
      return order?.status === "COMPLETED";
    }
    return false;
  }

  private async surchargePct(method: string): Promise<number> {
    const rows = await this.rest<Array<{ surcharge_percent: number | null }>>(
      `/payment_method_settings?method=eq.${encodeURIComponent(method)}&select=surcharge_percent&limit=1`,
    ).catch(() => null);
    const pct = Number(rows?.[0]?.surcharge_percent ?? 0);
    return Number.isFinite(pct) ? Math.max(0, pct) : 0;
  }

  private async rest<T>(path: string, init: RequestInit = {}): Promise<T> {
    const base = this.config.get<string>("SUPABASE_URL")?.replace(/\/$/, "");
    const key =
      this.config.get<string>("SUPABASE_SERVICE_ROLE_KEY") || this.config.get<string>("SUPABASE_ANON_KEY");
    if (!base || !key) throw new Error("Supabase REST not configured");
    const res = await fetch(`${base}/rest/v1${path}`, {
      ...init,
      headers: {
        apikey: key,
        Authorization: `Bearer ${key}`,
        "Content-Type": "application/json",
        ...(init.headers || {}),
      },
    });
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new Error(`Supabase REST ${res.status}: ${text}`);
    }
    if (res.status === 204) return {} as T;
    return (await res.json()) as T;
  }
}
