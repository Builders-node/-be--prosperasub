import { Injectable } from "@nestjs/common";
import {
  CleaningBillingType,
  CleaningChecklistType,
  CleaningClientStatus,
  CleaningPaymentTiming,
  CleaningScheduleStatus,
  DayOfWeek,
  Prisma,
} from "@prisma/client";
import { PrismaService } from "../prisma/prisma.service";
import type {
  CompleteCleaningBookingDto,
  CreateCustomCleaningPlanDto,
  UpdateCleaningClientStatusDto,
  UpdateRecurringScheduleStatusDto,
} from "./admin-cleaning.dto";

export interface AdminUserDto {
  id: string;
  email: string | null;
  name: string | null;
  displayName: string | null;
  authProvider: string;
  avatarUrl: string | null;
  roles: string[];
  createdAt: string;
  lastLoginAt: string | null;
}

@Injectable()
export class AdminService {
  constructor(private readonly prisma: PrismaService) {}

  async listUsers(): Promise<AdminUserDto[]> {
    if (process.env.NODE_ENV === "test" || process.env.SKIP_DATABASE_CONNECT === "true" || !process.env.DATABASE_URL) {
      return [
        {
          id: "owned-user-frorex",
          email: "frorex.studio@gmail.com",
          name: "Frorex Studio",
          displayName: "Frorex Studio",
          authProvider: "EMAIL",
          avatarUrl: null,
          roles: ["SUPER_ADMIN", "USER"],
          createdAt: new Date("2026-01-01T00:00:00.000Z").toISOString(),
          lastLoginAt: null,
        },
      ];
    }

    const users = await this.prisma.user.findMany({
      orderBy: { createdAt: "desc" },
      select: {
        id: true,
        email: true,
        name: true,
        displayName: true,
        authProvider: true,
        avatarUrl: true,
        createdAt: true,
        lastLoginAt: true,
        roles: {
          select: {
            role: true,
          },
        },
      },
    });

    return users.map((user) => ({
      id: user.id,
      email: user.email,
      name: user.name,
      displayName: user.displayName,
      authProvider: user.authProvider,
      avatarUrl: user.avatarUrl,
      roles: user.roles.map((role) => role.role),
      createdAt: user.createdAt.toISOString(),
      lastLoginAt: user.lastLoginAt?.toISOString() ?? null,
    }));
  }

  async listCustomCleaningClients() {
    if (this.shouldUseFallback()) {
      return [];
    }

    return this.prisma.cleaningClient.findMany({
      where: {
        isPrivate: true,
        visibility: "admin_only",
        clientType: "custom_cleaning_client",
      },
      orderBy: { createdAt: "desc" },
      include: {
        customPlans: true,
        recurringSchedules: true,
        checklistTemplates: true,
        bookings: {
          include: {
            slot: true,
            completionReport: true,
          },
          orderBy: { slot: { startsAt: "asc" } },
        },
        completionReports: {
          orderBy: { completedAt: "desc" },
        },
      },
    });
  }

  async listCustomCleaningPlans() {
    if (this.shouldUseFallback()) {
      return [];
    }

    return this.prisma.cleaningCustomPlan.findMany({
      where: {
        isPrivate: true,
        visibility: "admin_only",
        clientType: "custom_cleaning_client",
      },
      orderBy: { createdAt: "desc" },
      include: {
        client: true,
        recurringSchedules: true,
        checklistTemplates: true,
      },
    });
  }

  async listCleaningBookings() {
    if (this.shouldUseFallback()) {
      return [];
    }

    return this.prisma.cleaningBooking.findMany({
      orderBy: { slot: { startsAt: "asc" } },
      include: {
        slot: true,
        client: true,
        customPlan: true,
        recurringSchedule: true,
        checklistTemplate: true,
        completionReport: true,
        user: {
          select: {
            id: true,
            email: true,
            name: true,
            displayName: true,
          },
        },
      },
    });
  }

  async listCleaningCompletionReports() {
    if (this.shouldUseFallback()) {
      return [];
    }

    return this.prisma.cleaningCompletionReport.findMany({
      orderBy: { completedAt: "desc" },
      include: {
        client: true,
        customPlan: true,
        booking: {
          include: {
            slot: true,
          },
        },
      },
    });
  }

  async createCustomCleaningPlan(input: CreateCustomCleaningPlanDto, adminUserId: string) {
    if (this.shouldUseFallback()) {
      return {
        client: {
          id: "cleaning-client-preview",
          companyName: input.companyName,
          isPrivate: true,
          visibility: "admin_only",
          clientType: "custom_cleaning_client",
        },
        plan: {
          id: "cleaning-custom-plan-preview",
          planName: input.planName,
          isPrivate: true,
          visibility: "admin_only",
          clientType: "custom_cleaning_client",
        },
        schedule: {
          id: "cleaning-recurring-schedule-preview",
          status: "ACTIVE",
        },
        bookingsCreated: 0,
        conflicts: [],
      };
    }

    const daysOfWeek = input.daysOfWeek.map((day) => day as DayOfWeek);
    const status = this.toClientStatus(input.status);
    const startDate = this.dateOnly(input.startDate);
    const endDate = input.endDate ? this.dateOnly(input.endDate) : this.addMonths(startDate, 2);
    const conflicts: string[] = [];

    return this.prisma.$transaction(async (tx) => {
      const client = await tx.cleaningClient.create({
        data: {
          companyName: input.companyName,
          contactPerson: input.contactPerson,
          email: input.email,
          phone: input.phone,
          location: input.location,
          serviceType: input.serviceType,
          notes: input.notes,
          internalAdminNotes: input.internalAdminNotes,
          startDate,
          status,
          isPrivate: true,
          visibility: "admin_only",
          clientType: "custom_cleaning_client",
        },
      });

      const plan = await tx.cleaningCustomPlan.create({
        data: {
          clientId: client.id,
          planName: input.planName,
          customPriceCents: input.customPriceCents,
          billingType: this.toBillingType(input.billingType),
          monthlyInvoice: input.monthlyInvoice,
          paymentTiming: this.toPaymentTiming(input.paymentTiming),
          customTerms: input.customTerms,
          serviceFrequency: input.serviceFrequency,
          daysOfWeek,
          deepCleaningAddOn: input.deepCleaningAddOn,
          estimatedMonthlyTotalCents: input.estimatedMonthlyTotalCents,
          customChecklist: input.dailyChecklist ?? [],
          status,
          isPrivate: true,
          visibility: "admin_only",
          clientType: "custom_cleaning_client",
        },
      });

      const schedule = await tx.cleaningRecurringSchedule.create({
        data: {
          clientId: client.id,
          customPlanId: plan.id,
          startDate,
          endDate: input.endDate ? this.dateOnly(input.endDate) : null,
          daysOfWeek,
          preferredStartTime: input.preferredStartTime,
          preferredEndTime: input.preferredEndTime,
          assignedCleaner: input.assignedCleaner,
          location: input.location,
          serviceDurationMinutes: input.serviceDurationMinutes,
          repeatFrequency: input.repeatFrequency ?? "weekly",
          status: CleaningScheduleStatus.ACTIVE,
        },
      });

      const dailyTemplate = await tx.cleaningChecklistTemplate.create({
        data: {
          clientId: client.id,
          customPlanId: plan.id,
          templateType: CleaningChecklistType.DAILY_UPKEEP,
          name: "Daily upkeep checklist",
          items: input.dailyChecklist ?? [],
          isActive: true,
        },
      });

      await tx.cleaningChecklistTemplate.create({
        data: {
          clientId: client.id,
          customPlanId: plan.id,
          templateType: CleaningChecklistType.DEEP_CLEANING,
          name: "Deep cleaning checklist",
          items: input.deepCleaningChecklist ?? [],
          isActive: true,
        },
      });

      let bookingsCreated = 0;
      const weekdaySet = new Set(daysOfWeek);

      for (let date = new Date(startDate); date <= endDate; date = this.addDays(date, 1)) {
        if (!weekdaySet.has(this.dayOfWeek(date))) continue;

        const startsAt = this.combineDateTime(date, input.preferredStartTime);
        const endsAt = this.combineDateTime(date, input.preferredEndTime);
        const slot = await this.findOrCreateCleaningSlot(tx, startsAt, endsAt);
        const bookedCount = await tx.cleaningBooking.count({
          where: {
            slotId: slot.id,
            status: "BOOKED",
          },
        });

        if (bookedCount >= slot.capacity) {
          conflicts.push(this.formatDate(date));
          continue;
        }

        await tx.cleaningBooking.create({
          data: {
            userId: adminUserId,
            subscriptionId: null,
            clientId: client.id,
            customPlanId: plan.id,
            recurringScheduleId: schedule.id,
            checklistTemplateId: dailyTemplate.id,
            slotId: slot.id,
            status: "BOOKED",
            notes: input.notes,
            location: input.location,
            assignedCleaner: input.assignedCleaner,
            serviceDurationMinutes: input.serviceDurationMinutes,
            isPrivate: true,
            visibility: "admin_only",
            clientType: "custom_cleaning_client",
          },
        });
        bookingsCreated += 1;
      }

      return {
        client,
        plan,
        schedule,
        bookingsCreated,
        conflicts,
      };
    });
  }

  async updateCleaningClientStatus(id: string, input: UpdateCleaningClientStatusDto) {
    if (this.shouldUseFallback()) {
      return { id, status: input.status };
    }

    return this.prisma.cleaningClient.update({
      where: { id },
      data: { status: this.toClientStatus(input.status) },
    });
  }

  async deleteCleaningClient(id: string) {
    if (this.shouldUseFallback()) {
      return { deleted: true };
    }

    await this.prisma.cleaningClient.delete({
      where: { id },
    });
    return { deleted: true };
  }

  async updateRecurringScheduleStatus(id: string, input: UpdateRecurringScheduleStatusDto) {
    if (this.shouldUseFallback()) {
      return { id, status: input.status };
    }

    return this.prisma.cleaningRecurringSchedule.update({
      where: { id },
      data: {
        status: this.toScheduleStatus(input.status),
        pausedAt: input.status === "paused" ? new Date() : null,
      },
    });
  }

  async completeCleaningBooking(id: string, input: CompleteCleaningBookingDto) {
    if (this.shouldUseFallback()) {
      return { id: "cleaning-completion-report-preview", bookingId: id };
    }

    return this.prisma.$transaction(async (tx) => {
      const booking = await tx.cleaningBooking.findUniqueOrThrow({
        where: { id },
      });

      const report = await tx.cleaningCompletionReport.create({
        data: {
          bookingId: id,
          clientId: booking.clientId,
          customPlanId: booking.customPlanId,
          checklistCompleted: input.checklistCompleted ?? [],
          notes: input.notes,
          photoUrl: input.photoUrl,
          issueReport: input.issueReport,
          completedBy: input.completedBy,
          completedAt: new Date(),
        },
      });

      await tx.cleaningBooking.update({
        where: { id },
        data: { status: "COMPLETED" },
      });

      return report;
    });
  }

  private shouldUseFallback() {
    return process.env.NODE_ENV === "test" || process.env.SKIP_DATABASE_CONNECT === "true" || !process.env.DATABASE_URL;
  }

  private toClientStatus(status: string) {
    return status.toUpperCase() as CleaningClientStatus;
  }

  private toBillingType(type: string) {
    return type.toUpperCase() as CleaningBillingType;
  }

  private toPaymentTiming(type: string) {
    return type.toUpperCase() as CleaningPaymentTiming;
  }

  private toScheduleStatus(status: string) {
    return status.toUpperCase() as CleaningScheduleStatus;
  }

  private dateOnly(value: string) {
    return new Date(`${value}T00:00:00.000Z`);
  }

  private addDays(date: Date, days: number) {
    const next = new Date(date);
    next.setUTCDate(next.getUTCDate() + days);
    return next;
  }

  private addMonths(date: Date, months: number) {
    const next = new Date(date);
    next.setUTCMonth(next.getUTCMonth() + months);
    return next;
  }

  private combineDateTime(date: Date, time: string) {
    const [hours = "0", minutes = "0"] = time.split(":");
    const combined = new Date(date);
    combined.setUTCHours(Number(hours), Number(minutes), 0, 0);
    return combined;
  }

  private dayOfWeek(date: Date): DayOfWeek {
    const days: DayOfWeek[] = [
      DayOfWeek.SUNDAY,
      DayOfWeek.MONDAY,
      DayOfWeek.TUESDAY,
      DayOfWeek.WEDNESDAY,
      DayOfWeek.THURSDAY,
      DayOfWeek.FRIDAY,
      DayOfWeek.SATURDAY,
    ];
    return days[date.getUTCDay()];
  }

  private formatDate(date: Date) {
    return date.toISOString().slice(0, 10);
  }

  private async findOrCreateCleaningSlot(
    tx: Prisma.TransactionClient,
    startsAt: Date,
    endsAt: Date,
  ) {
    const existing = await tx.cleaningAvailableSlot.findFirst({
      where: {
        startsAt,
        endsAt,
        isActive: true,
      },
    });

    if (existing) {
      return existing;
    }

    return tx.cleaningAvailableSlot.create({
      data: {
        startsAt,
        endsAt,
        capacity: 1,
        isActive: true,
      },
    });
  }
}
