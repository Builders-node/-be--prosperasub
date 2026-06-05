import {
  formatFrequencyLabel,
  formatPricingLabel,
  resolveMonthlyPriceCents,
  validateCleaningPlanPricing,
} from "./cleaning-plan-pricing";

describe("cleaning plan pricing helpers", () => {
  it("formats flexible frequency labels", () => {
    expect(formatFrequencyLabel({ frequencyUnit: "day", frequencyCount: 2 })).toBe("2x per day");
    expect(formatFrequencyLabel({ frequencyUnit: "week", frequencyCount: 6 })).toBe("6x per week");
    expect(formatFrequencyLabel({ frequencyUnit: "month", frequencyCount: 26 })).toBe("26x per month");
    expect(formatFrequencyLabel({ frequencyUnit: "custom", customFrequencyLabel: "Custom schedule" })).toBe("Custom schedule");
  });

  it("uses fixed monthly price as the final amount even when price-per-cleaning exists", () => {
    expect(resolveMonthlyPriceCents({
      pricingMode: "fixed_monthly_price",
      monthlyPriceCents: 25500,
      pricePerCleaningCents: 1000,
      frequencyUnit: "month",
      frequencyCount: 26,
    })).toBe(25500);
  });

  it("falls back to calculated estimate from price per cleaning and frequency count", () => {
    expect(resolveMonthlyPriceCents({
      pricingMode: "calculated_estimate",
      monthlyPriceCents: null,
      pricePerCleaningCents: 1975,
      frequencyUnit: "month",
      frequencyCount: 4,
    })).toBe(7900);
  });

  it("formats pricing labels for monthly and per-cleaning modes", () => {
    expect(formatPricingLabel({
      pricingMode: "fixed_monthly_price",
      monthlyPriceCents: 26000,
      pricePerCleaningCents: 1000,
      frequencyUnit: "week",
      frequencyCount: 6,
    })).toBe("$260.00/month");

    expect(formatPricingLabel({
      pricingMode: "price_per_cleaning",
      monthlyPriceCents: null,
      pricePerCleaningCents: 1975,
      frequencyUnit: "month",
      frequencyCount: 4,
    })).toBe("$19.75 per cleaning");
  });

  it("validates required fields for custom and counted frequencies", () => {
    expect(() => validateCleaningPlanPricing({
      pricingMode: "custom_manual",
      monthlyPriceCents: null,
      pricePerCleaningCents: null,
      frequencyUnit: "custom",
      frequencyCount: null,
      customFrequencyLabel: "",
    })).toThrow("Custom frequency label is required.");

    expect(() => validateCleaningPlanPricing({
      pricingMode: "fixed_monthly_price",
      monthlyPriceCents: 10000,
      pricePerCleaningCents: null,
      frequencyUnit: "week",
      frequencyCount: 0,
    })).toThrow("Frequency count must be positive.");
  });
});
