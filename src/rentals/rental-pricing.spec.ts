import { calcRentalPrice, extraCost, rentalDaysBetween, surchargeCentsFor } from "./rental-pricing";

/**
 * The server's copy of the rental arithmetic must agree with the browser's
 * (frontend features/vehicles/types/carRental.ts) to the cent — the browser
 * shows the number, the server writes it, and a disagreement is a dispute.
 */
describe("calcRentalPrice", () => {
  const car = { daily_price_cents: 5000, weekly_price_cents: 30000, monthly_price_cents: 100000 };

  it("prices short rentals by the day", () => {
    expect(calcRentalPrice(car, 3).totalCents).toBe(15000);
  });

  it("prices 7+ days by weeks, leftover days capped at one week", () => {
    // 10 days = 1 week (30000) + min(3×5000, 30000) = 45000
    expect(calcRentalPrice(car, 10).totalCents).toBe(45000);
    // 13 leftover-heavy: 1 week + min(6×5000=30000, 30000) = 60000
    expect(calcRentalPrice(car, 13).totalCents).toBe(60000);
  });

  it("never exceeds the monthly cap, and records the discount", () => {
    const p = calcRentalPrice(car, 30); // 4 weeks + 2 days = 130000 → capped
    expect(p.totalCents).toBe(100000);
    expect(p.discountCents).toBe(p.subtotalCents - 100000);
    expect(p.discountPct).toBe(Math.round((p.discountCents / p.subtotalCents) * 100));
  });

  it("survives a car with no weekly or monthly price", () => {
    expect(calcRentalPrice({ daily_price_cents: 5000, weekly_price_cents: 0, monthly_price_cents: 0 }, 14).totalCents)
      .toBe(70000);
  });
});

describe("extraCost", () => {
  it("multiplies per_day extras and leaves flat ones alone", () => {
    expect(extraCost({ price_cents: 500, price_type: "per_day" }, 4)).toBe(2000);
    expect(extraCost({ price_cents: 2500, price_type: "flat" }, 4)).toBe(2500);
  });
});

describe("rentalDaysBetween", () => {
  it("counts inclusively — same day is one day", () => {
    expect(rentalDaysBetween("2026-09-02", "2026-09-02")).toBe(1);
    expect(rentalDaysBetween("2026-09-02", "2026-09-05")).toBe(4);
  });
});

describe("surchargeCentsFor", () => {
  it("mirrors the checkout's rounding: round(base × (1+pct/100)) − base", () => {
    expect(surchargeCentsFor(10000, 5)).toBe(500);
    expect(surchargeCentsFor(3333, 2.5)).toBe(Math.round(3333 * 1.025) - 3333);
    expect(surchargeCentsFor(10000, 0)).toBe(0);
  });
});
