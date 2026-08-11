import { Injectable, Logger, Optional } from "@nestjs/common";
import { PrismaService } from "../prisma/prisma.service";
import {
  type CleaningFrequencyUnit,
  type CleaningPricingMode,
  monthlyCleaningEstimate,
  resolveMonthlyPriceCents,
} from "./cleaning-plan-pricing";

export interface CleaningPackageDto {
  id: string;
  name: string;
  description: string;
  pricePerCleaningCents: number | null;
  monthlyPriceCents: number;
  cleaningsPerMonth: number;
  frequencyUnit: CleaningFrequencyUnit;
  frequencyCount: number | null;
  customFrequencyLabel: string | null;
  pricingMode: CleaningPricingMode;
  isActive: boolean;
}

@Injectable()
export class CatalogService {
  private readonly logger = new Logger(CatalogService.name);

  constructor(@Optional() private readonly prisma?: PrismaService) {}

  private readonly fallbackCleaningPackages: CleaningPackageDto[] = [
    {
      id: "cleaning-1-bedroom-studio",
      name: "1 Bedroom & Studio",
      description: "1 cleaning per week for studios and one-bedroom homes.",
      pricePerCleaningCents: 1975,
      monthlyPriceCents: 7900,
      cleaningsPerMonth: 4,
      frequencyUnit: "month",
      frequencyCount: 4,
      customFrequencyLabel: null,
      pricingMode: "price_per_cleaning",
      isActive: true
    },
    {
      id: "cleaning-2-bedroom",
      name: "2 Bedroom",
      description: "1 cleaning per week for two-bedroom homes.",
      pricePerCleaningCents: 2475,
      monthlyPriceCents: 9900,
      cleaningsPerMonth: 4,
      frequencyUnit: "month",
      frequencyCount: 4,
      customFrequencyLabel: null,
      pricingMode: "price_per_cleaning",
      isActive: true
    },
    {
      id: "00000000-0000-4000-8000-000000000201",
      name: "1 Bedroom & Studio",
      description: "1 cleaning per week for studios and one-bedroom homes.",
      pricePerCleaningCents: 1975,
      monthlyPriceCents: 7900,
      cleaningsPerMonth: 4,
      frequencyUnit: "month",
      frequencyCount: 4,
      customFrequencyLabel: null,
      pricingMode: "price_per_cleaning",
      isActive: true
    },
    {
      id: "00000000-0000-4000-8000-000000000202",
      name: "2 Bedroom",
      description: "1 cleaning per week for two-bedroom homes.",
      pricePerCleaningCents: 2475,
      monthlyPriceCents: 9900,
      cleaningsPerMonth: 4,
      frequencyUnit: "month",
      frequencyCount: 4,
      customFrequencyLabel: null,
      pricingMode: "price_per_cleaning",
      isActive: true
    }
  ];

  async listCleaningPackages(): Promise<CleaningPackageDto[]> {
    const packages = await this.loadCleaningPackages();
    return packages.filter((pkg) => pkg.isActive);
  }

  async getCleaningPackage(id: string): Promise<CleaningPackageDto | undefined> {
    if (!id) return undefined;

    const packageFromDb = await this.loadCleaningPackageById(id);
    if (packageFromDb?.isActive) return packageFromDb;

    return this.fallbackCleaningPackages.find((pkg) => pkg.id === id && pkg.isActive);
  }

  getOverview() {
    return {
      users: 1,
      activeSubscriptions: 0,
      pendingPayments: 0,
      totalRevenueCents: 0,
      cleaningActiveSubscriptions: 0,
      cleaningUpcomingBookings: 0,
      cleaningAvailableSlots: 0
    };
  }

  async seedCleaningSlots() {
    if (!this.prisma || !this.prisma.isAvailable()) {
      return { ok: false, reason: "database_unavailable" };
    }

    const SLOT_TIMES: [string, string][] = [
      ["08:00:00", "09:45:00"],
      ["10:00:00", "11:45:00"],
      ["12:00:00", "13:45:00"],
      ["14:00:00", "15:45:00"],
    ];

    const today = new Date();
    const todayStr = today.toISOString().slice(0, 10);

    const existing = await this.prisma.cleaningAvailableSlot.findFirst({
      where: { date: { gte: todayStr }, isActive: true },
    });
    if (existing) return { ok: true, seeded: false };

    // Read capacity settings from DB
    const settings = await this.prisma.globalSetting.findMany({
      where: { key: { in: ["default_slot_capacity", "saturday_slot_capacity"] } },
    });
    const settingsMap = new Map(settings.map((s) => [s.key, s.value]));
    const defaultCapacity = Math.max(1, Number(settingsMap.get("default_slot_capacity")) || 1);
    const saturdayCapacity = Math.max(1, Number(settingsMap.get("saturday_slot_capacity")) || defaultCapacity);

    const slots: { date: string; startTime: string; endTime: string; maxBookings: number; currentBookings: number; isActive: boolean }[] = [];
    for (let offset = 0; offset < 110; offset++) {
      const d = new Date(today);
      d.setDate(d.getDate() + offset);
      if (d.getDay() === 0) continue;
      const dateStr = d.toISOString().slice(0, 10);
      const capacity = d.getDay() === 6 ? saturdayCapacity : defaultCapacity;

      for (const [startTime, endTime] of SLOT_TIMES) {
        slots.push({ date: dateStr, startTime, endTime, maxBookings: capacity, currentBookings: 0, isActive: true });
      }
    }

    await this.prisma.cleaningAvailableSlot.createMany({ data: slots, skipDuplicates: true });
    return { ok: true, seeded: true, count: slots.length };
  }

  private async loadCleaningPackages(): Promise<CleaningPackageDto[]> {
    if (process.env.NODE_ENV === "test") {
      return this.fallbackCleaningPackages;
    }

    try {
      // status AND visibility, not just is_active. This endpoint is public and
      // unauthenticated; filtering on is_active alone published both "Cowork
      // Apartment" plans, which are visibility=private and priced for assigned
      // clients only. Archived and draft plans leaked the same way — the admin's
      // Archive button writes status, and nothing here was reading it.
      const rows = await this.supabaseRest<CleaningPackageRow[]>(
        "/cleaning_packages?select=id,name,description,price_per_cleaning_cents,monthly_price_cents,cleanings_per_month,frequency_unit,frequency_count,custom_frequency_label,pricing_mode,is_active&deleted_at=is.null&is_active=eq.true&status=eq.active&visibility=eq.public&order=price_per_cleaning_cents.asc"
      );
      return rows.map((row) => this.mapCleaningPackage(row));
    } catch (error) {
      this.logger.warn(`Could not load cleaning packages from Supabase REST: ${this.errorMessage(error)}`);
      return this.fallbackCleaningPackages;
    }
  }

  private async loadCleaningPackageById(id: string): Promise<CleaningPackageDto | undefined> {
    if (process.env.NODE_ENV === "test") {
      return this.fallbackCleaningPackages.find((pkg) => pkg.id === id);
    }

    try {
      // By id, visibility is deliberately NOT filtered: a private plan is
      // reached by the link its assigned client was given, and this lookup is
      // what payments/ prices a checkout from. status is filtered, so an
      // archived or draft plan cannot be paid for through an old link.
      const rows = await this.supabaseRest<CleaningPackageRow[]>(
        `/cleaning_packages?select=id,name,description,price_per_cleaning_cents,monthly_price_cents,cleanings_per_month,frequency_unit,frequency_count,custom_frequency_label,pricing_mode,is_active&id=eq.${encodeURIComponent(id)}&deleted_at=is.null&status=eq.active&limit=1`
      );
      return rows[0] ? this.mapCleaningPackage(rows[0]) : undefined;
    } catch (error) {
      this.logger.warn(`Could not load cleaning package ${id} from Supabase REST: ${this.errorMessage(error)}`);
      return undefined;
    }
  }

  private mapCleaningPackage(row: CleaningPackageRow): CleaningPackageDto {
    const frequencyUnit = row.frequency_unit ?? "month";
    const frequencyCount = row.frequency_count ?? row.cleanings_per_month;
    const pricingMode = row.pricing_mode ?? "price_per_cleaning";
    const base = {
      frequencyUnit,
      frequencyCount,
      pricingMode,
      monthlyPriceCents: row.monthly_price_cents,
      pricePerCleaningCents: row.price_per_cleaning_cents ?? null,
    };
    return {
      id: row.id,
      name: row.name,
      description: row.description ?? "",
      pricePerCleaningCents: row.price_per_cleaning_cents,
      monthlyPriceCents: resolveMonthlyPriceCents(base),
      cleaningsPerMonth: row.cleanings_per_month || monthlyCleaningEstimate(base),
      frequencyUnit,
      frequencyCount,
      customFrequencyLabel: row.custom_frequency_label,
      pricingMode,
      isActive: row.is_active
    };
  }

  private async supabaseRest<T = unknown>(path: string): Promise<T> {
    const baseUrl = process.env.SUPABASE_URL?.replace(/\/$/, "");
    const anonKey = process.env.SUPABASE_ANON_KEY;
    if (!baseUrl || !anonKey) throw new Error("Supabase REST is not configured.");

    const response = await fetch(`${baseUrl}/rest/v1${path}`, {
      headers: {
        apikey: anonKey,
        Authorization: `Bearer ${anonKey}`,
        "Content-Type": "application/json"
      }
    });

    if (!response.ok) {
      const body = await response.text().catch(() => response.statusText);
      throw new Error(`Supabase REST ${response.status}: ${body}`);
    }

    return response.json() as Promise<T>;
  }

  private errorMessage(error: unknown) {
    return error instanceof Error ? error.message : String(error);
  }
}

type CleaningPackageRow = {
  id: string;
  name: string;
  description: string | null;
  price_per_cleaning_cents: number | null;
  cleanings_per_month: number;
  monthly_price_cents: number | null;
  frequency_unit: CleaningFrequencyUnit | null;
  frequency_count: number | null;
  custom_frequency_label: string | null;
  pricing_mode: CleaningPricingMode | null;
  is_active: boolean;
};
