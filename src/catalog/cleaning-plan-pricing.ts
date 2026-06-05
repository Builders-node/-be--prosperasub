export type CleaningFrequencyUnit = "day" | "week" | "month" | "custom";
export type CleaningPricingMode =
  | "fixed_monthly_price"
  | "price_per_cleaning"
  | "calculated_estimate"
  | "custom_manual";

export type CleaningPlanPricingInput = {
  frequencyUnit?: CleaningFrequencyUnit | string | null;
  frequencyCount?: number | null;
  customFrequencyLabel?: string | null;
  pricingMode?: CleaningPricingMode | string | null;
  monthlyPriceCents?: number | null;
  pricePerCleaningCents?: number | null;
};

export const VALID_FREQUENCY_UNITS: CleaningFrequencyUnit[] = ["day", "week", "month", "custom"];
export const VALID_PRICING_MODES: CleaningPricingMode[] = [
  "fixed_monthly_price",
  "price_per_cleaning",
  "calculated_estimate",
  "custom_manual",
];

export function normalizeFrequencyUnit(value: unknown): CleaningFrequencyUnit {
  return VALID_FREQUENCY_UNITS.includes(value as CleaningFrequencyUnit)
    ? value as CleaningFrequencyUnit
    : "month";
}

export function normalizePricingMode(value: unknown): CleaningPricingMode {
  return VALID_PRICING_MODES.includes(value as CleaningPricingMode)
    ? value as CleaningPricingMode
    : "price_per_cleaning";
}

export function monthlyCleaningEstimate(input: CleaningPlanPricingInput): number {
  const unit = normalizeFrequencyUnit(input.frequencyUnit);
  const count = Math.max(0, Number(input.frequencyCount ?? 0));
  if (unit === "day") return Math.round(count * 30);
  if (unit === "week") return Math.round((count * 52) / 12);
  if (unit === "month") return Math.round(count);
  return 0;
}

export function resolveMonthlyPriceCents(input: CleaningPlanPricingInput): number {
  const mode = normalizePricingMode(input.pricingMode);
  const monthly = Number(input.monthlyPriceCents ?? 0);
  const pricePerCleaning = Number(input.pricePerCleaningCents ?? 0);
  const estimate = pricePerCleaning * monthlyCleaningEstimate(input);

  if (mode === "fixed_monthly_price" || mode === "custom_manual") {
    return Math.max(0, monthly || estimate);
  }

  if (mode === "calculated_estimate") {
    return Math.max(0, monthly || estimate);
  }

  return Math.max(0, estimate || monthly);
}

export function formatFrequencyLabel(input: CleaningPlanPricingInput): string {
  const unit = normalizeFrequencyUnit(input.frequencyUnit);
  if (unit === "custom") {
    return input.customFrequencyLabel?.trim() || "Custom schedule";
  }
  const count = Number(input.frequencyCount ?? 0);
  return `${count}x per ${unit}`;
}

export function formatPricingLabel(input: CleaningPlanPricingInput): string {
  const cents = (value: number) => `$${(value / 100).toFixed(2)}`;
  const mode = normalizePricingMode(input.pricingMode);

  if (mode === "price_per_cleaning" && Number(input.pricePerCleaningCents ?? 0) > 0) {
    return `${cents(Number(input.pricePerCleaningCents))} per cleaning`;
  }

  const monthly = resolveMonthlyPriceCents(input);
  if (monthly > 0) return `${cents(monthly)}/month`;
  if (mode === "custom_manual") return "Custom pricing";
  return "Price pending";
}

export function validateCleaningPlanPricing(input: CleaningPlanPricingInput) {
  const unit = normalizeFrequencyUnit(input.frequencyUnit);
  const mode = normalizePricingMode(input.pricingMode);
  const count = Number(input.frequencyCount ?? 0);
  const monthly = Number(input.monthlyPriceCents ?? 0);
  const pricePer = Number(input.pricePerCleaningCents ?? 0);

  if (unit !== "custom" && count <= 0) {
    throw new Error("Frequency count must be positive.");
  }

  if (unit === "custom" && !input.customFrequencyLabel?.trim()) {
    throw new Error("Custom frequency label is required.");
  }

  if ((mode === "fixed_monthly_price" || mode === "custom_manual") && monthly <= 0) {
    throw new Error("Monthly price is required for this pricing mode.");
  }

  if (mode === "price_per_cleaning" && pricePer <= 0) {
    throw new Error("Price per cleaning is required for this pricing mode.");
  }

  if (mode === "calculated_estimate" && monthly <= 0 && pricePer <= 0) {
    throw new Error("Monthly price or price per cleaning is required for calculated estimates.");
  }
}
