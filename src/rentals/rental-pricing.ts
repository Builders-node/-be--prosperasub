/**
 * Capped rental pricing — the server's copy of the arithmetic that decides
 * what a rental costs, ported verbatim from
 * frontend/src/features/vehicles/types/carRental.ts (calcRentalPrice /
 * extraCost). The browser still computes it for DISPLAY; this file is what
 * actually lands in the row, so a tampered request cannot name its own price.
 *
 *  - daily (1–6 days)   → daily × days
 *  - weekly (7+ days)   → full_weeks × weekly + min(leftover × daily, weekly)
 *  - monthly cap        → the total can never exceed monthly_price_cents
 */

export interface RentalPriceInput {
  daily_price_cents: number | null;
  weekly_price_cents: number | null;
  monthly_price_cents: number | null;
}

export interface RentalPriceCalc {
  rentalDays: number;
  effectiveDailyRate: number;
  subtotalCents: number;
  discountCents: number;
  discountPct: number;
  totalCents: number;
}

export function calcRentalPrice(vehicle: RentalPriceInput, rentalDays: number): RentalPriceCalc {
  const daily = vehicle.daily_price_cents || 0;
  const weekly = vehicle.weekly_price_cents || 0;
  const monthly = vehicle.monthly_price_cents || 0;

  let subtotalCents: number;
  if (weekly > 0 && rentalDays >= 7) {
    const weeks = Math.floor(rentalDays / 7);
    const leftoverDays = rentalDays % 7;
    subtotalCents = weeks * weekly + Math.min(leftoverDays * daily, weekly);
  } else {
    subtotalCents = rentalDays * daily;
  }

  let totalCents = subtotalCents;
  if (monthly > 0 && totalCents > monthly) totalCents = monthly;

  const discountCents = Math.max(0, subtotalCents - totalCents);
  const discountPct = subtotalCents > 0 ? Math.round((discountCents / subtotalCents) * 100) : 0;
  const effectiveDailyRate = rentalDays > 0 ? Math.round(totalCents / rentalDays) : daily;

  return { rentalDays, effectiveDailyRate, subtotalCents, discountCents, discountPct, totalCents };
}

/** One extra's cost for a rental of `days` days. */
export function extraCost(extra: { price_cents: number; price_type: string }, days: number): number {
  return extra.price_type === "per_day" ? extra.price_cents * Math.max(1, days) : extra.price_cents;
}

/** Inclusive day count between two YYYY-MM-DD dates (same day → 1). */
export function rentalDaysBetween(startISO: string, endISO: string): number {
  const s = new Date(`${startISO}T00:00:00Z`).getTime();
  const e = new Date(`${endISO}T00:00:00Z`).getTime();
  const diff = Math.round((e - s) / 86400000);
  return Math.max(1, diff + 1);
}

/**
 * The payment-method fee on top of the base, mirroring the checkout's
 * `addSurchargeCents`: round(base × (1 + pct/100)) − base. Mirrored exactly —
 * a one-cent disagreement here would make every charged total dispute its row.
 */
export function surchargeCentsFor(baseCents: number, pct: number): number {
  if (!Number.isFinite(pct) || pct <= 0) return 0;
  return Math.round(baseCents * (1 + pct / 100)) - baseCents;
}
