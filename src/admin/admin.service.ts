import { BadRequestException, Injectable, NotFoundException } from "@nestjs/common";
import {
  CleaningBillingType,
  CleaningBookingStatus,
  CleaningChecklistType,
  CleaningClientStatus,
  CleaningPaymentTiming,
  CleaningScheduleStatus,
  DayOfWeek,
  Prisma,
} from "@prisma/client";
import { CleaningCalendarSyncService } from "../google-calendar/cleaning-calendar-sync.service";
import { PrismaService } from "../prisma/prisma.service";
import { AuthService } from "../auth/auth.service";
import type {
  CompleteCleaningBookingDto,
  CreateCustomCleaningPlanDto,
  UpdateCleaningBookingDto,
  UpdateCleaningClientDto,
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
  constructor(
    private readonly prisma: PrismaService,
    private readonly cleaningCalendarSync: CleaningCalendarSyncService,
    private readonly auth: AuthService,
  ) {}

  async listUsers(): Promise<AdminUserDto[]> {
    // Always include every user the auth service knows about (Frorex + cached users).
    const inMemoryUsers: AdminUserDto[] = this.auth.listAllUsers().map((u) => ({
      id: u.id,
      email: u.email,
      name: u.name,
      displayName: u.display_name,
      authProvider: u.auth_provider.toUpperCase(),
      avatarUrl: u.avatar_url,
      roles: u.roles.map((r) => r.toUpperCase()),
      createdAt: new Date().toISOString(),
      lastLoginAt: null,
    }));

    if (process.env.NODE_ENV === "test") {
      return inMemoryUsers;
    }

    // Merge with users persisted in Supabase via RPC (HTTPS — always works from Vercel).
    let dbUsers: AdminUserDto[] = [];
    try {
      type DbRow = {
        id: string; email: string | null; name: string | null;
        display_name: string | null; auth_provider: string | null;
        avatar_url: string | null; created_at: string | null;
        last_login_at: string | null; roles: string[];
      };
      const rows = await this.auth.supabaseRpc<DbRow[]>("admin_list_users", {});

      if (rows && Array.isArray(rows)) {
        const inMemoryEmails = new Set(
          inMemoryUsers.map((u) => u.email?.toLowerCase()).filter(Boolean),
        );
        dbUsers = rows
          .filter((row) => !inMemoryEmails.has(row.email?.toLowerCase() ?? ""))
          .map((row) => ({
            id:           row.id,
            email:        row.email,
            name:         row.name,
            displayName:  row.display_name,
            authProvider: (row.auth_provider ?? "email").toUpperCase(),
            avatarUrl:    row.avatar_url,
            roles:        (row.roles ?? []).map((r) => r.toUpperCase()),
            createdAt:    row.created_at ?? new Date().toISOString(),
            lastLoginAt:  row.last_login_at ?? null,
          }));
      }
    } catch {
      // Supabase unavailable — return what we have from memory.
    }

    return [...inMemoryUsers, ...dbUsers];
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

  async listCleaningClients() {
    if (this.shouldUseFallback()) {
      return [];
    }

    const [clients, subscriptions] = await Promise.all([
      this.prisma.cleaningClient.findMany({
        orderBy: { createdAt: "desc" },
        include: {
          customPlans: true,
          recurringSchedules: true,
          bookings: {
            include: { slot: true },
            orderBy: { slot: { startsAt: "desc" } },
          },
        },
      }),
      this.prisma.cleaningSubscription.findMany({
        include: {
          user: {
            select: {
              id: true,
              email: true,
              name: true,
              displayName: true,
            },
          },
          package: true,
          bookings: {
            include: { slot: true },
            orderBy: { slot: { startsAt: "desc" } },
          },
        },
      }),
    ]);

    const publicSubscriptionsByEmail = new Map<string, typeof subscriptions>();
    for (const subscription of subscriptions) {
      const email = this.normalizeLookup(subscription.user.email);
      if (!email) continue;
      publicSubscriptionsByEmail.set(email, [...(publicSubscriptionsByEmail.get(email) ?? []), subscription]);
    }

    const storedEmails = new Set<string>();
    const storedRows = clients.map((client) => {
      const email = this.normalizeLookup(client.email);
      if (email) storedEmails.add(email);
      const publicSubscriptions = email ? publicSubscriptionsByEmail.get(email) ?? [] : [];
      const activePlansCount =
        client.customPlans.filter((plan) => plan.status !== "ARCHIVED" && plan.status !== "CANCELLED").length +
        publicSubscriptions.filter((subscription) => subscription.isActive).length;
      const lastBooking = client.bookings[0] ?? publicSubscriptions.flatMap((subscription) => subscription.bookings)[0];

      return {
        ...client,
        clientTypeLabel: this.clientTypeLabel(client, publicSubscriptions.length > 0),
        activePlansCount,
        lastServiceDate: lastBooking?.slot.startsAt?.toISOString() ?? null,
        isDerived: false,
      };
    });

    const derivedRows = subscriptions
      .filter((subscription) => {
        const email = this.normalizeLookup(subscription.user.email);
        return email && !storedEmails.has(email);
      })
      .map((subscription) => ({
        id: `public-client-${subscription.userId}`,
        companyName: subscription.user.displayName || subscription.user.name || subscription.user.email || "Regular client",
        contactPerson: subscription.user.displayName || subscription.user.name || null,
        email: subscription.user.email,
        phone: null,
        location: "Prospera Village",
        serviceType: subscription.package.name,
        notes: null,
        internalAdminNotes: null,
        invoicePreferences: null,
        status: subscription.isActive ? "ACTIVE" : "INACTIVE",
        isPrivate: false,
        visibility: "admin_only",
        clientType: "regular_cleaning_client",
        clientTypeLabel: "Regular",
        activePlansCount: subscription.isActive ? 1 : 0,
        lastServiceDate: subscription.bookings[0]?.slot.startsAt?.toISOString() ?? null,
        isDerived: true,
        publicUserId: subscription.userId,
      }));

    return [...storedRows, ...derivedRows];
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

    const bookingIds: string[] = [];
    const result = await this.prisma.$transaction(async (tx) => {
      const client = await this.resolveCleaningClientForPlan(tx, input, startDate, status);

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

        const booking = await tx.cleaningBooking.create({
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
        bookingIds.push(booking.id);
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

    const calendarSyncResults = await this.syncBookingsToCalendar(bookingIds);
    return { ...result, calendarSyncResults };
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

  async updateCleaningClient(id: string, input: UpdateCleaningClientDto) {
    if (this.shouldUseFallback()) {
      return { id, ...input };
    }

    const client = await this.prisma.cleaningClient.findUnique({ where: { id } });
    if (!client) {
      throw new NotFoundException("Cleaning client not found");
    }

    if (!input.email?.trim() && !input.phone?.trim()) {
      throw new BadRequestException("Email or phone is required");
    }

    return this.prisma.cleaningClient.update({
      where: { id },
      data: {
        companyName: input.companyName,
        contactPerson: input.contactPerson,
        email: input.email,
        phone: input.phone,
        location: input.location,
        serviceType: input.serviceType,
        notes: input.notes,
        internalAdminNotes: input.internalAdminNotes,
        invoicePreferences: input.invoicePreferences,
        status: this.toClientStatus(input.status),
        clientType: input.clientType || client.clientType,
        visibility: input.visibility || client.visibility,
        isPrivate: input.isPrivate ?? client.isPrivate,
      },
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

    const report = await this.prisma.$transaction(async (tx) => {
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

    await this.cleaningCalendarSync.syncBookingById(id);
    return report;
  }

  async updateCleaningBooking(id: string, input: UpdateCleaningBookingDto) {
    if (this.shouldUseFallback()) {
      return { id, ...input };
    }

    const booking = await this.prisma.cleaningBooking.update({
      where: { id },
      data: {
        status: input.status ? this.toBookingStatus(input.status) : undefined,
        notes: input.notes,
        location: input.location,
        assignedCleaner: input.assignedCleaner,
        serviceDurationMinutes: input.serviceDurationMinutes,
        googleCalendarSyncStatus: "pending",
      },
    });

    const calendarSyncResult = await this.cleaningCalendarSync.syncBookingById(id);
    return { booking, calendarSyncResult };
  }

  async syncCleaningBookingCalendar(id: string) {
    const fallbackReason = this.getFallbackReason();
    if (fallbackReason) {
      return { ok: true, bookingId: id, skipped: true, skipReason: fallbackReason };
    }

    if (!this.cleaningCalendarSync.isConfigured()) {
      return {
        ok: false,
        bookingId: id,
        calendarId: this.cleaningCalendarSync.getSharedAdminCalendarId(),
        error: this.googleCalendarConfigurationMessage(),
        configuration: this.cleaningCalendarSync.getConfigurationStatus(),
      };
    }

    return this.cleaningCalendarSync.syncBookingById(id);
  }

  /**
   * Sync a booking to Google Calendar using data provided directly by the
   * frontend (e.g. from localStorage). Does NOT require a database connection.
   */
  async syncBookingFromData(
    bookingId: string,
    data: {
      date: string;
      startTime: string;
      endTime: string;
      clientName?: string;
      planName?: string;
      location?: string;
      status?: string;
      notes?: string;
      googleCalendarEventId?: string;
    },
  ) {
    if (!this.cleaningCalendarSync.isConfigured()) {
      return {
        ok: false,
        bookingId,
        calendarId: this.cleaningCalendarSync.getSharedAdminCalendarId(),
        error: this.googleCalendarConfigurationMessage(),
        configuration: this.cleaningCalendarSync.getConfigurationStatus(),
      };
    }

    const timeZone = process.env.GOOGLE_CALENDAR_TIME_ZONE || "America/Tegucigalpa";

    // Normalise to HH:mm — slots may be stored as "08:00:00" (HH:mm:ss)
    const hhmm = (t: string) => t.slice(0, 5);

    // Honduras is always UTC-6 (no DST).  Append the offset so Node.js
    // parses the wall-clock time as local HN time and stores the correct
    // UTC value in the Date object.  Without this, Vercel's UTC runtime
    // treats "08:00" as UTC → Google Calendar shows 2 AM instead of 8 AM.
    const hnOffset = "-06:00";
    const start = new Date(`${data.date}T${hhmm(data.startTime)}:00${hnOffset}`);
    const end   = new Date(`${data.date}T${hhmm(data.endTime)}:00${hnOffset}`);

    if (isNaN(start.getTime()) || isNaN(end.getTime())) {
      return { ok: false, bookingId, error: `Invalid date/time: ${data.date} ${data.startTime}-${data.endTime}` };
    }

    const clientName = data.clientName || "Cleaning client";
    const location   = data.location || "Prospera Village";
    const isCancelled = (data.status ?? "").toLowerCase() === "cancelled";
    const titleBase  = `Cleaning - ${clientName}`;

    const description = [
      `Status: ${data.status ?? "booked"}`,
      `Client: ${clientName}`,
      data.planName ? `Plan: ${data.planName}` : null,
      data.notes    ? `Notes: ${data.notes}`   : null,
      `Booking ID: ${bookingId}`,
    ].filter(Boolean).join("\n");

    try {
      let result: { id: string; htmlLink?: string | null };

      if (data.googleCalendarEventId) {
        result = await this.cleaningCalendarSync["googleCalendar"].updateEvent(data.googleCalendarEventId, {
          summary:     isCancelled ? `[Cancelled] ${titleBase}` : titleBase,
          location,
          description,
          start,
          end,
          colorId: isCancelled ? "11" : undefined,
        });
      } else {
        result = await this.cleaningCalendarSync["googleCalendar"].createEvent({
          summary:     isCancelled ? `[Cancelled] ${titleBase}` : titleBase,
          location,
          description,
          start,
          end,
          colorId: isCancelled ? "11" : undefined,
        });
      }

      return {
        ok: true,
        bookingId,
        calendarId: this.cleaningCalendarSync.getSharedAdminCalendarId(),
        googleCalendarEventId: result.id,
        googleCalendarEventLink: result.htmlLink ?? null,
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : "Google Calendar sync failed";
      return { ok: false, bookingId, error: message };
    }
  }

  async syncAllCleaningBookingsCalendar() {
    const fallbackReason = this.getFallbackReason();
    if (fallbackReason) {
      return {
        ok: true,
        skipped: true,
        skipReason: fallbackReason,
        calendarId: null,
        total: 0,
        synced: 0,
        failed: 0,
        results: [],
      };
    }

    if (!this.cleaningCalendarSync.isConfigured()) {
      return {
        ok: false,
        calendarId: this.cleaningCalendarSync.getSharedAdminCalendarId(),
        total: 0,
        synced: 0,
        failed: 0,
        error: this.googleCalendarConfigurationMessage(),
        configuration: this.cleaningCalendarSync.getConfigurationStatus(),
        results: [],
      };
    }

    const bookings = await this.prisma.cleaningBooking.findMany({
      where: {
        status: {
          in: [
            CleaningBookingStatus.BOOKED,
            CleaningBookingStatus.COMPLETED,
            CleaningBookingStatus.CANCELLED,
          ],
        },
      },
      orderBy: { createdAt: "desc" },
      select: { id: true },
    });

    const results = await this.syncBookingsToCalendar(bookings.map((booking) => booking.id));
    const failed = results.filter((result) => !result.ok).length;
    return {
      ok: failed === 0,
      calendarId: this.cleaningCalendarSync.getSharedAdminCalendarId(),
      total: results.length,
      synced: results.length - failed,
      failed,
      results,
    };
  }

  async deleteCleaningBooking(id: string) {
    if (this.shouldUseFallback()) {
      return { deleted: true };
    }

    await this.cleaningCalendarSync.deleteCalendarEventForBooking(id);
    await this.prisma.cleaningBooking.delete({ where: { id } });
    return { deleted: true };
  }

  private shouldUseFallback() {
    return Boolean(this.getFallbackReason());
  }

  private getFallbackReason() {
    if (process.env.NODE_ENV === "test") return "test_environment";
    if (process.env.SKIP_DATABASE_CONNECT === "true") return "database_connect_skipped";
    if (!process.env.DATABASE_URL) return "missing_database_url";
    if (!this.prisma.isAvailable()) return "database_unavailable";
    return null;
  }

  private googleCalendarConfigurationMessage() {
    const status = this.cleaningCalendarSync.getConfigurationStatus();
    if (!status.hasCalendarId) return "Google cleaning calendar ID is missing.";
    if (!status.hasClientEmail || !status.clientEmailLooksServiceAccount) {
      return "Google Calendar service account email is missing or invalid.";
    }
    if (!status.hasPrivateKey || !status.privateKeyLooksValid) {
      return "Google Calendar service account private key is missing or invalid.";
    }
    return "Google Calendar is not configured.";
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

  private toBookingStatus(status: string) {
    return status.toUpperCase() as CleaningBookingStatus;
  }

  private async syncBookingsToCalendar(bookingIds: string[]) {
    const results = [];
    for (const bookingId of bookingIds) {
      results.push(await this.cleaningCalendarSync.syncBookingById(bookingId));
    }
    return results;
  }

  private normalizeLookup(value?: string | null) {
    return String(value || "").trim().toLowerCase();
  }

  private clientTypeLabel(client: { isPrivate: boolean; clientType: string }, hasPublicSubscription: boolean) {
    const isPrivate = client.isPrivate || client.clientType === "custom_cleaning_client";
    if (isPrivate && hasPublicSubscription) return "Both";
    if (isPrivate) return "Private";
    return "Regular";
  }

  private async resolveCleaningClientForPlan(
    tx: Prisma.TransactionClient,
    input: CreateCustomCleaningPlanDto,
    startDate: Date,
    status: CleaningClientStatus,
  ) {
    if (input.existingClientId) {
      const existingClient = await tx.cleaningClient.findUnique({ where: { id: input.existingClientId } });
      if (!existingClient) {
        throw new NotFoundException("Selected cleaning client was not found");
      }
      return existingClient;
    }

    if (!input.email?.trim() && !input.phone?.trim()) {
      throw new BadRequestException("Email or phone is required");
    }

    const duplicateFilters: Prisma.CleaningClientWhereInput[] = [];
    if (input.email?.trim()) duplicateFilters.push({ email: { equals: input.email.trim(), mode: "insensitive" } });
    if (input.phone?.trim()) duplicateFilters.push({ phone: input.phone.trim() });
    if (input.companyName?.trim() && input.location?.trim()) {
      duplicateFilters.push({
        companyName: { equals: input.companyName.trim(), mode: "insensitive" },
        location: { equals: input.location.trim(), mode: "insensitive" },
      });
    }

    const duplicateClient = duplicateFilters.length
      ? await tx.cleaningClient.findFirst({ where: { OR: duplicateFilters } })
      : null;

    if (duplicateClient) {
      throw new BadRequestException("Similar client already exists. Reuse the existing client instead of creating a duplicate.");
    }

    return tx.cleaningClient.create({
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
