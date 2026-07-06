import { BadRequestException, Injectable, Logger, NotFoundException, Optional } from "@nestjs/common";
import { Prisma } from "@prisma/client";
import { AccountNotificationsService } from "../account/account-notifications.service";
import { CleaningReminderService } from "../account/cleaning-reminder.service";
import { CleaningCalendarSyncService } from "../google-calendar/cleaning-calendar-sync.service";
import { BeachCourtCalendarSyncService } from "../google-calendar/beach-court-calendar-sync.service";
import { BlinkService } from "../payments/blink.service";
import { SimpleFiService } from "../payments/simplefi.service";
import { MailService } from "../mail/mail.service";
import { BillingService } from "../billing/billing.service";
import type { PaymentMethod } from "../billing/payment-provider.port";
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

type AdminUserRow = {
  id: string;
  email: string | null;
  name: string | null;
  display_name: string | null;
  auth_provider: string | null;
  avatar_url?: string | null;
  created_at: string | Date | null;
  last_login_at: string | Date | null;
  banned_until?: string | Date | null;
  roles: string[] | null;
  subscriptions: unknown;
  linked_clients: unknown;
};

const SUBSCRIPTION_WRITE_COLUMNS = new Set([
  "user_id",
  "client_id",
  "package_id",
  "start_date",
  "end_date",
  "service_start_date",
  "service_end_date",
  "paid_until",
  "billing_period_months",
  "monthly_price_cents",
  "total_price_cents",
  "cleanings_remaining",
  "payment_status",
  "subscription_status",
  "payment_method",
  "payment_reference",
  "recurring_day_of_week",
  "recurring_time",
  "apartment_note",
  "admin_notes",
  "is_active",
]);

@Injectable()
export class AdminService {
  private readonly logger = new Logger(AdminService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly cleaningCalendarSync: CleaningCalendarSyncService,
    private readonly auth: AuthService,
    @Optional() private readonly blink?: BlinkService,
    @Optional() private readonly accountNotifications?: AccountNotificationsService,
    @Optional() private readonly cleaningReminders?: CleaningReminderService,
    @Optional() private readonly mail?: MailService,
    @Optional() private readonly beachCourtCalendarSync?: BeachCourtCalendarSyncService,
    @Optional() private readonly simplefi?: SimpleFiService,
    @Optional() private readonly billing?: BillingService,
  ) {}

  /** Map a stored legacy payment_method to a Billing PaymentMethod (null = unsupported). */
  private billingMethodOf(method?: string | null): PaymentMethod | null {
    const m = String(method || "").toLowerCase();
    if (m === "onchain") return "onchain";
    if (m === "lightning" || m === "blink") return "lightning";
    if (m === "infinita" || m === "crypto" || m === "lives") return "lives";
    if (m === "paypal") return "paypal";
    return null;
  }

  /** Best-effort captured amount for a reconciled subscription row, per table. */
  private subAmountCents(table: string, sub: Record<string, any>): number | null {
    if (table === "cleaning_subscriptions") return Number(sub.total_price_cents) || Number(sub.monthly_price_cents) || null;
    if (table === "beach_club_subscriptions") return Number(sub.total_cents) || null;
    if (table === "food_subscriptions") {
      const weekly = Number(sub.weekly_price_cents) || 0;
      const weeks = (Number(sub.commitment_weeks) || 1) * (Number(sub.periods_paid) || 1);
      return weekly ? weekly * weeks : null;
    }
    return null;
  }

  // ── Beach Court → Google Calendar sync ─────────────────────────────────────

  async syncBeachCourtBookingCreated(bookingId: string) {
    if (!this.beachCourtCalendarSync?.isConfigured()) {
      return { ok: false, skipped: true, reason: "not_configured" as const };
    }
    // Read engine booking → bridge to legacy court via bookable_resources so we
    // can resolve the Google Calendar id. Uses PostgREST (matches admin.service).
    if (!this.prisma.isAvailable()) return { ok: false, error: "DB unavailable" };
    const booking = await this.prisma.booking.findUnique({ where: { id: bookingId } });
    if (!booking) return { ok: false, error: "Booking not found" };
    if (booking.status !== "confirmed" && booking.status !== "held") return { ok: false, skipped: true, reason: "not_active" as const };

    const bridge = await this.supabaseRest<Array<Record<string, any>>>(
      `/bookable_resources?id=eq.${encodeURIComponent(String(booking.resourceId))}&select=source_resource_id&limit=1`,
    );
    const legacyCourtId = bridge?.[0]?.source_resource_id;
    if (!legacyCourtId) return { ok: false, error: "Resource → court bridge not found" };

    const courts = await this.supabaseRest<Array<Record<string, any>>>(
      `/beach_club_courts?id=eq.${encodeURIComponent(String(legacyCourtId))}&select=id,name,google_calendar_id&limit=1`,
    );
    const court = courts?.[0];
    if (!court) return { ok: false, error: "Court not found" };
    if (!court.google_calendar_id) return { ok: false, skipped: true, reason: "no_calendar" as const };

    const dateStr = new Date(booking.startAt).toISOString().slice(0, 10);
    const startHour = new Date(booking.startAt).getUTCHours();
    const endHour = new Date(booking.endAt).getUTCHours() || startHour + 1;

    const result = await this.beachCourtCalendarSync.syncCreated({
      bookingId,
      courtId: String(court.id),
      courtName: String(court.name),
      courtGoogleCalendarId: String(court.google_calendar_id),
      date: dateStr,
      startHour,
      endHour,
      memberName: booking.label ?? null,
      notes: booking.notes ?? null,
    });

    // Tag the engine booking with the sync outcome (best-effort — never fail).
    await this.prisma.booking.update({
      where: { id: bookingId },
      data: {
        googleCalendarEventId: result.eventId ?? null,
        googleCalendarSyncStatus: result.error ? "failed" : result.skipped ? "skipped" : "synced",
      },
    }).catch(() => { /* ignore */ });

    return { ok: !result.error, eventId: result.eventId ?? null, error: result.error };
  }

  /** Pull Google Calendar events for a single court and mirror them into our DB. */
  async pullBeachCourtFromGoogle(courtId: string) {
    if (!this.beachCourtCalendarSync?.isConfigured()) {
      return { ok: false, skipped: true, reason: "not_configured" as const };
    }
    const courts = await this.supabaseRest<Array<Record<string, any>>>(
      `/beach_club_courts?id=eq.${encodeURIComponent(courtId)}&select=id,name,google_calendar_id&limit=1`,
    );
    const court = courts?.[0];
    if (!court) return { ok: false, error: "Court not found" };
    if (!court.google_calendar_id) return { ok: false, skipped: true, reason: "no_calendar" as const };
    const result = await this.beachCourtCalendarSync.pullExternalBookings({
      courtId: String(court.id),
      courtName: String(court.name),
      courtGoogleCalendarId: String(court.google_calendar_id),
    });
    await this.supabaseRest(`/beach_club_courts?id=eq.${encodeURIComponent(courtId)}`, {
      method: "PATCH",
      body: JSON.stringify({ google_last_synced_at: new Date().toISOString() }),
    }).catch(() => { /* ignore */ });
    return result;
  }

  /** Pull Google Calendar events for every court that has a calendar attached. */
  async pullAllBeachCourtsFromGoogle() {
    if (!this.beachCourtCalendarSync?.isConfigured()) {
      return { ok: false, skipped: true, reason: "not_configured" as const };
    }
    const courts = await this.supabaseRest<Array<Record<string, any>>>(
      `/beach_club_courts?is_active=eq.true&google_calendar_id=not.is.null&select=id`,
    ).catch(() => []);
    const results: Array<{ courtId: string } & Awaited<ReturnType<typeof this.pullBeachCourtFromGoogle>>> = [];
    for (const c of courts ?? []) {
      results.push({ courtId: String(c.id), ...(await this.pullBeachCourtFromGoogle(String(c.id))) });
    }
    return { ok: true, courts: results.length, results };
  }

  async syncBeachCourtBookingDeleted(input: { bookingId: string; courtId: string; eventId: string | null }) {
    if (!this.beachCourtCalendarSync?.isConfigured()) return { ok: true, skipped: true };
    if (!input.eventId) return { ok: true, skipped: true };
    const courts = await this.supabaseRest<Array<Record<string, any>>>(
      `/beach_club_courts?id=eq.${encodeURIComponent(input.courtId)}&select=google_calendar_id&limit=1`,
    );
    const calendarId = courts?.[0]?.google_calendar_id;
    if (!calendarId) return { ok: true, skipped: true };
    return this.beachCourtCalendarSync.syncDeleted({ eventId: input.eventId, courtGoogleCalendarId: calendarId });
  }

  // ── Payment reminders (in-app + email) ──────────────────────────────────────

  /** Deliver one reminder via in-app notification (if the member has an account) and email (if on file). */
  private async deliverPaymentReminder(opts: {
    recipientUserId?: string | null;
    email?: string | null;
    name?: string | null;
    serviceLabel: string;
    amountCents?: number;
    relatedType: string;
    relatedId: string;
  }): Promise<string[]> {
    const methods: string[] = [];
    const amount = (Number(opts.amountCents) || 0) / 100;
    const amountStr = amount > 0 ? ` ($${amount.toFixed(2)})` : "";

    if (opts.recipientUserId && this.accountNotifications) {
      await this.accountNotifications.create({
        recipientUserId: String(opts.recipientUserId),
        category: "payment",
        type: "payment_pending",
        title: "Payment reminder",
        body: `Your payment for ${opts.serviceLabel}${amountStr} is still pending. Please complete it to keep your subscription active.`,
        relatedEntityType: opts.relatedType,
        relatedEntityId: opts.relatedId,
        actionUrl: "/my-subscriptions",
      }).then(() => methods.push("in-app")).catch((e) => this.logger.warn(`reminder in-app failed: ${(e as Error).message}`));
    }

    if (opts.email && this.mail) {
      const name = opts.name || "there";
      await this.mail.sendMail({
        to: opts.email,
        subject: `Payment reminder — ${opts.serviceLabel}`,
        text: `Hi ${name}, this is a friendly reminder that your payment for ${opts.serviceLabel}${amountStr} is still pending. Please complete it to keep your subscription active. — ProsperaSub`,
        html: `<p>Hi ${name},</p><p>This is a friendly reminder that your payment for <strong>${opts.serviceLabel}</strong>${amountStr} is still pending. Please complete it to keep your subscription active.</p><p>Thank you,<br/>ProsperaSub</p>`,
      }).then(() => methods.push("email")).catch((e) => this.logger.warn(`reminder email failed: ${(e as Error).message}`));
    }

    return methods;
  }

  private async loadUserContact(userId?: string | null): Promise<{ email?: string; name?: string; display_name?: string } | undefined> {
    if (!userId) return undefined;
    const rows = await this.supabaseRest<Array<Record<string, any>>>(
      `/users?id=eq.${encodeURIComponent(String(userId))}&select=email,name,display_name&limit=1`,
    ).catch(() => []);
    return rows?.[0];
  }

  async sendFoodPaymentReminder(subscriptionId: string) {
    const rows = await this.supabaseRest<Array<Record<string, any>>>(
      `/food_subscriptions?id=eq.${encodeURIComponent(subscriptionId)}` +
      `&select=id,user_id,customer_name,payment_status,status,provider_id,weekly_price_cents,commitment_weeks&limit=1`,
    );
    const sub = rows?.[0];
    if (!sub) throw new NotFoundException("Subscription not found");
    if ((sub.payment_status ?? "") === "paid") return { ok: false, skipped: true, reason: "already_paid" as const };

    const user = await this.loadUserContact(sub.user_id);
    const providerRows = sub.provider_id
      ? await this.supabaseRest<Array<{ name: string }>>(`/food_providers?id=eq.${encodeURIComponent(String(sub.provider_id))}&select=name&limit=1`).catch(() => [])
      : [];
    const methods = await this.deliverPaymentReminder({
      recipientUserId: sub.user_id,
      email: user?.email,
      name: user?.display_name || user?.name || sub.customer_name,
      serviceLabel: providerRows?.[0]?.name ?? "your meal plan",
      amountCents: (Number(sub.weekly_price_cents) || 0) * (Number(sub.commitment_weeks) || 1),
      relatedType: "food_subscription",
      relatedId: subscriptionId,
    });
    return methods.length ? { ok: true, methods } : { ok: false, skipped: true, reason: "no_channel" as const };
  }

  async sendCleaningPaymentReminder(subscriptionId: string) {
    const rows = await this.supabaseRest<Array<Record<string, any>>>(
      `/cleaning_subscriptions?id=eq.${encodeURIComponent(subscriptionId)}` +
      `&select=id,user_id,client_id,package_id,payment_status,subscription_status,monthly_price_cents,total_price_cents&limit=1`,
    );
    const sub = rows?.[0];
    if (!sub) throw new NotFoundException("Subscription not found");
    if ((sub.payment_status ?? "") === "paid") return { ok: false, skipped: true, reason: "already_paid" as const };

    let email: string | undefined;
    let name: string | undefined;
    const user = await this.loadUserContact(sub.user_id);
    if (user) { email = user.email; name = user.display_name || user.name; }
    if (!email && sub.client_id) {
      const clients = await this.supabaseRest<Array<Record<string, any>>>(
        `/cleaning_clients?id=eq.${encodeURIComponent(String(sub.client_id))}&select=email,company_name&limit=1`,
      ).catch(() => []);
      email = clients?.[0]?.email; name = name || clients?.[0]?.company_name;
    }
    const pkgRows = sub.package_id
      ? await this.supabaseRest<Array<{ name: string }>>(`/cleaning_packages?id=eq.${encodeURIComponent(String(sub.package_id))}&select=name&limit=1`).catch(() => [])
      : [];
    const methods = await this.deliverPaymentReminder({
      recipientUserId: sub.user_id,
      email, name,
      serviceLabel: pkgRows?.[0]?.name ? `${pkgRows[0].name} (cleaning)` : "your cleaning plan",
      amountCents: Number(sub.total_price_cents) || Number(sub.monthly_price_cents) || 0,
      relatedType: "cleaning_subscription",
      relatedId: subscriptionId,
    });
    return methods.length ? { ok: true, methods } : { ok: false, skipped: true, reason: "no_channel" as const };
  }

  async sendBeachPaymentReminder(subscriptionId: string) {
    const rows = await this.supabaseRest<Array<Record<string, any>>>(
      `/beach_club_subscriptions?id=eq.${encodeURIComponent(subscriptionId)}` +
      `&select=id,user_id,customer_name,customer_email,plan_name,total_cents,payment_status,status&limit=1`,
    );
    const sub = rows?.[0];
    if (!sub) throw new NotFoundException("Subscription not found");
    if ((sub.payment_status ?? "") === "paid") return { ok: false, skipped: true, reason: "already_paid" as const };

    const user = await this.loadUserContact(sub.user_id);
    const methods = await this.deliverPaymentReminder({
      recipientUserId: sub.user_id,
      email: user?.email || sub.customer_email,
      name: user?.display_name || user?.name || sub.customer_name,
      serviceLabel: sub.plan_name ? `${sub.plan_name} (Beach Club)` : "your Beach Club membership",
      amountCents: Number(sub.total_cents) || 0,
      relatedType: "beach_club_subscription",
      relatedId: subscriptionId,
    });
    return methods.length ? { ok: true, methods } : { ok: false, skipped: true, reason: "no_channel" as const };
  }

  /** Send reminders to every unpaid (non-cancelled) subscription of a service. */
  async remindAllUnpaid(service: "food" | "cleaning" | "beach", providerId?: string) {
    let path: string;
    let send: (id: string) => Promise<any>;
    if (service === "food") {
      path = `/food_subscriptions?select=id&payment_status=neq.paid&status=neq.cancelled`
        + (providerId ? `&provider_id=eq.${encodeURIComponent(providerId)}` : "");
      send = (id) => this.sendFoodPaymentReminder(id);
    } else if (service === "cleaning") {
      path = `/cleaning_subscriptions?select=id&payment_status=neq.paid&subscription_status=neq.cancelled&deleted_at=is.null`;
      send = (id) => this.sendCleaningPaymentReminder(id);
    } else {
      path = `/beach_club_subscriptions?select=id&payment_status=neq.paid&status=neq.cancelled`;
      send = (id) => this.sendBeachPaymentReminder(id);
    }
    const rows = await this.supabaseRest<Array<{ id: string }>>(path).catch(() => []);
    let sent = 0, skipped = 0;
    for (const r of rows ?? []) {
      try {
        const res = await send(r.id);
        if (res?.ok) sent++; else skipped++;
      } catch (e) {
        skipped++;
        this.logger.warn(`remindAllUnpaid ${service} ${r.id} failed: ${(e as Error).message}`);
      }
    }
    return { ok: true, total: (rows ?? []).length, sent, skipped };
  }

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

  async listUsersFull() {
    if (this.shouldUseFallback()) {
      const [users, legacyRoles, subscriptions, packages, clients, rbacUserRoles, rbacRoles] = await Promise.all([
        this.supabaseRest<Array<Record<string, any>>>("/users?select=id,email,name,display_name,auth_provider,avatar_url,created_at,last_login_at,banned_until&deleted_at=is.null&order=created_at.desc"),
        this.supabaseRest<Array<{ user_id: string; role: string }>>("/user_roles?select=user_id,role"),
        this.supabaseRest<Array<Record<string, any>>>("/cleaning_subscriptions?select=id,user_id,package_id,payment_status,subscription_status,is_active,monthly_price_cents&deleted_at=is.null"),
        this.supabaseRest<Array<{ id: string; name: string }>>("/cleaning_packages?select=id,name"),
        this.supabaseRest<Array<Record<string, any>>>("/cleaning_clients?select=id,company_name,email,status,user_id&deleted_at=is.null"),
        this.supabaseRest<Array<{ user_id: string; role_id: string }>>("/rbac_user_roles?select=user_id,role_id").catch(() => []),
        this.supabaseRest<Array<{ id: string; slug: string }>>("/rbac_roles?select=id,slug").catch(() => []),
      ]);
      const rolesByUser = new Map<string, string[]>();
      for (const role of legacyRoles) {
        rolesByUser.set(role.user_id, [...(rolesByUser.get(role.user_id) ?? []), String(role.role).toLowerCase()]);
      }
      const rbacSlugById = new Map((rbacRoles ?? []).map((r) => [String(r.id), r.slug]));
      const rbacByUser = new Map<string, string[]>();
      for (const ur of rbacUserRoles ?? []) {
        const slug = rbacSlugById.get(String(ur.role_id));
        if (!slug) continue;
        rbacByUser.set(String(ur.user_id), [...(rbacByUser.get(String(ur.user_id)) ?? []), slug]);
      }
      const packageById = new Map(packages.map((pkg) => [pkg.id, pkg.name]));
      const subscriptionsByUser = new Map<string, Record<string, any>[]>();
      for (const subscription of subscriptions) {
        subscriptionsByUser.set(subscription.user_id, [
          ...(subscriptionsByUser.get(subscription.user_id) ?? []),
          { ...subscription, package_name: packageById.get(subscription.package_id) ?? "Unknown" },
        ]);
      }
      const clientsByEmail = new Map<string, Record<string, any>[]>();
      const clientsByUserId = new Map<string, Record<string, any>[]>();
      for (const client of clients) {
        const normalizedClient = { ...client, status: String(client.status ?? "").toLowerCase() };
        const emailKey = String(client.email ?? "").trim().toLowerCase();
        if (emailKey) {
          clientsByEmail.set(emailKey, [...(clientsByEmail.get(emailKey) ?? []), normalizedClient]);
        }
        if (client.user_id) {
          const uid = String(client.user_id);
          clientsByUserId.set(uid, [...(clientsByUserId.get(uid) ?? []), normalizedClient]);
        }
      }
      return users.map((user) => {
        const byEmail = clientsByEmail.get(String(user.email ?? "").trim().toLowerCase()) ?? [];
        const byUserId = clientsByUserId.get(String(user.id)) ?? [];
        const seenIds = new Set<string>();
        const merged = [...byEmail, ...byUserId].filter((c) => {
          if (seenIds.has(c.id)) return false;
          seenIds.add(c.id);
          return true;
        });
        return {
          ...user,
          roles: rolesByUser.get(user.id) ?? ["user"],
          rbacRoles: rbacByUser.get(String(user.id)) ?? [],
          subscriptions: subscriptionsByUser.get(user.id) ?? [],
          linkedClients: merged,
          isBlocked: user.banned_until ? new Date(user.banned_until).getTime() > Date.now() : false,
        };
      });
    }

    const rows = await this.prisma.$queryRawUnsafe<AdminUserRow[]>(
      `WITH legacy_roles AS (
         SELECT user_id::text, array_agg(lower(role::text) ORDER BY role::text) AS roles
         FROM public.user_roles
         GROUP BY user_id::text
       ),
       rbac_roles_agg AS (
         SELECT ur.user_id,
           array_agg(r.slug ORDER BY r.name) AS rbac_roles
         FROM public.rbac_user_roles ur
         JOIN public.rbac_roles r ON r.id = ur.role_id
         WHERE ur.removed_at IS NULL AND r.status = 'active'
         GROUP BY ur.user_id
       ),
       user_subscriptions AS (
         SELECT cs.user_id::text,
           jsonb_agg(
             jsonb_build_object(
               'id', cs.id,
               'user_id', cs.user_id,
               'package_id', cs.package_id,
               'payment_status', cs.payment_status,
               'subscription_status', cs.subscription_status,
               'is_active', cs.is_active,
               'monthly_price_cents', cs.monthly_price_cents,
               'package_name', COALESCE(cp.name, 'Unknown')
             )
             ORDER BY cs.created_at DESC
           ) AS subscriptions
         FROM public.cleaning_subscriptions cs
         LEFT JOIN public.cleaning_packages cp ON cp.id = cs.package_id
         WHERE cs.deleted_at IS NULL
         GROUP BY cs.user_id::text
       ),
       email_clients AS (
         SELECT lower(trim(email)) AS email,
           jsonb_agg(
             jsonb_build_object(
               'id', id,
               'company_name', company_name,
               'email', email,
               'status', lower(status)
             )
             ORDER BY created_at DESC
           ) AS linked_clients
         FROM public.cleaning_clients
         WHERE deleted_at IS NULL AND email IS NOT NULL AND trim(email) <> ''
         GROUP BY lower(trim(email))
       ),
       userid_clients AS (
         SELECT user_id::text,
           jsonb_agg(
             jsonb_build_object(
               'id', id,
               'company_name', company_name,
               'email', email,
               'status', lower(status)
             )
             ORDER BY created_at DESC
           ) AS linked_clients
         FROM public.cleaning_clients
         WHERE deleted_at IS NULL AND user_id IS NOT NULL
         GROUP BY user_id::text
       ),
       merged_clients AS (
         SELECT u.id::text AS uid,
           COALESCE(
             (SELECT jsonb_agg(DISTINCT val) FROM (
               SELECT val FROM jsonb_array_elements(COALESCE(ec.linked_clients, '[]'::jsonb)) AS val
               UNION
               SELECT val FROM jsonb_array_elements(COALESCE(uc.linked_clients, '[]'::jsonb)) AS val
             ) sub),
             '[]'::jsonb
           ) AS linked_clients
         FROM public.users u
         LEFT JOIN email_clients ec ON ec.email = lower(trim(COALESCE(u.email, '')))
         LEFT JOIN userid_clients uc ON uc.user_id = u.id::text
         WHERE u.deleted_at IS NULL
       )
       SELECT u.id::text,
         u.email,
         u.name,
         u.display_name,
         u.auth_provider,
         u.avatar_url,
         u.created_at,
         u.last_login_at,
         u.banned_until,
         COALESCE(lr.roles, ARRAY['user']) AS roles,
         COALESCE(rra.rbac_roles, ARRAY[]::text[]) AS rbac_roles,
         COALESCE(us.subscriptions, '[]'::jsonb) AS subscriptions,
         COALESCE(mc.linked_clients, '[]'::jsonb) AS linked_clients
       FROM public.users u
       LEFT JOIN legacy_roles lr ON lr.user_id = u.id::text
       LEFT JOIN rbac_roles_agg rra ON rra.user_id = u.id::text
       LEFT JOIN user_subscriptions us ON us.user_id = u.id::text
       LEFT JOIN merged_clients mc ON mc.uid = u.id::text
       WHERE u.deleted_at IS NULL
       ORDER BY u.created_at DESC`,
    );

    return rows.map((row) => ({
      id: row.id,
      email: row.email,
      name: row.name,
      display_name: row.display_name,
      auth_provider: row.auth_provider ?? "email",
      avatar_url: row.avatar_url ?? null,
      created_at: row.created_at,
      last_login_at: row.last_login_at,
      roles: row.roles ?? ["user"],
      rbacRoles: (row as any).rbac_roles ?? [],
      subscriptions: row.subscriptions ?? [],
      linkedClients: row.linked_clients ?? [],
      isBlocked: row.banned_until ? new Date(row.banned_until).getTime() > Date.now() : false,
    }));
  }

  async listUserAuditLogs(userId: string) {
    if (this.shouldUseFallback()) {
      return this.supabaseRest(`/admin_audit_logs?select=*&entity_type=eq.user&entity_id=eq.${encodeURIComponent(userId)}&order=created_at.desc&limit=10`);
    }
    return this.prisma.$queryRawUnsafe(
      `SELECT *
       FROM public.admin_audit_logs
       WHERE entity_type = 'user' AND entity_id = $1
       ORDER BY created_at DESC
       LIMIT 10`,
      userId,
    );
  }

  async updateUser(userId: string, input: { name?: string; display_name?: string }, actorUserId: string) {
    const name = typeof input.name === "string" ? input.name : null;
    const displayName = typeof input.display_name === "string" ? input.display_name : null;

    if (this.shouldUseFallback()) {
      await this.supabaseRest(`/users?id=eq.${encodeURIComponent(userId)}&deleted_at=is.null`, {
        method: "PATCH",
        body: JSON.stringify({ ...(name !== null ? { name } : {}), ...(displayName !== null ? { display_name: displayName } : {}), updated_at: new Date().toISOString() }),
      });
      await this.auditAdminEvent(actorUserId, "edit", "user", userId, { name, display_name: displayName });
      return { ok: true };
    }

    await this.prisma.$executeRawUnsafe(
      `UPDATE public.users
       SET name = COALESCE($2, name),
           display_name = COALESCE($3, display_name),
           updated_at = now()
       WHERE id::text = $1 AND deleted_at IS NULL`,
      userId,
      name,
      displayName,
    );
    await this.auditAdminEvent(actorUserId, "edit", "user", userId, { name, display_name: displayName });
    return { ok: true };
  }

  async setUserBlocked(userId: string, block: boolean, actorUserId: string) {
    const bannedUntil = block ? "2099-12-31T23:59:59Z" : null;
    if (this.shouldUseFallback()) {
      await this.supabaseRest(`/users?id=eq.${encodeURIComponent(userId)}&deleted_at=is.null`, {
        method: "PATCH",
        body: JSON.stringify({ banned_until: bannedUntil, updated_at: new Date().toISOString() }),
      });
      await this.auditAdminEvent(actorUserId, block ? "block" : "unblock", "user", userId, {});
      return { ok: true };
    }
    await this.prisma.$executeRawUnsafe(
      `UPDATE public.users SET banned_until = $2, updated_at = now() WHERE id::text = $1 AND deleted_at IS NULL`,
      userId,
      bannedUntil,
    );
    await this.auditAdminEvent(actorUserId, block ? "block" : "unblock", "user", userId, {});
    return { ok: true };
  }

  async softDeleteUser(userId: string, actorUserId: string) {
    if (this.shouldUseFallback()) {
      await this.supabaseRest(`/users?id=eq.${encodeURIComponent(userId)}`, {
        method: "PATCH",
        body: JSON.stringify({ deleted_at: new Date().toISOString(), updated_at: new Date().toISOString() }),
      });
      await this.auditAdminEvent(actorUserId, "delete", "user", userId, {});
      return { ok: true };
    }
    await this.prisma.$executeRawUnsafe(
      `UPDATE public.users SET deleted_at = now(), updated_at = now() WHERE id::text = $1`,
      userId,
    );
    await this.auditAdminEvent(actorUserId, "delete", "user", userId, {});
    return { ok: true };
  }

  async listAdminSubscriptions(params: {
    page?: number | string;
    limit?: number | string;
    status?: string;
    q?: string;
    sortBy?: string;
    sortDir?: string;
  } = {}) {
    // Server-side pagination + filtering + sorting + stats in one round-trip.
    // Row count comes from a window COUNT(*) OVER() so we don't need a second
    // total query. Stats come from a single SELECT with FILTER clauses.
    const page   = Math.max(0, Number(params.page ?? 0) | 0);
    const limit  = Math.min(200, Math.max(1, Number(params.limit ?? 25) | 0));
    const offset = page * limit;
    const q      = String(params.q ?? "").trim();

    const STATUS_WHERE: Record<string, string> = {
      all:       ``,
      active:    `AND cs.payment_status = 'paid' AND (cs.subscription_status = 'active' OR (cs.is_active AND (cs.subscription_status IS NULL OR cs.subscription_status NOT IN ('paused','cancelled','expired'))))`,
      pending:   `AND cs.payment_status <> 'paid' AND (cs.subscription_status IS NULL OR cs.subscription_status NOT IN ('cancelled','expired'))`,
      paused:    `AND cs.subscription_status = 'paused'`,
      cancelled: `AND cs.subscription_status = 'cancelled'`,
      expired:   `AND cs.subscription_status = 'expired'`,
    };
    const whereStatus = STATUS_WHERE[String(params.status ?? "all")] ?? "";

    const SORT_COL: Record<string, string> = {
      user:   `COALESCE(u.display_name, u.name, cc.company_name, u.email)`,
      price:  `COALESCE(cs.monthly_price_cents, cs.total_price_cents, 0)`,
      period: `COALESCE(cs.service_start_date, cs.start_date)`,
      status: `CASE WHEN cs.payment_status <> 'paid' AND (cs.subscription_status IS NULL OR cs.subscription_status NOT IN ('cancelled','expired')) THEN 'pending' ELSE COALESCE(cs.subscription_status, CASE WHEN cs.is_active THEN 'active' ELSE 'inactive' END) END`,
    };
    const orderCol = SORT_COL[String(params.sortBy ?? "user")] ?? SORT_COL.user;
    const orderDir = String(params.sortDir ?? "asc").toLowerCase() === "desc" ? "DESC" : "ASC";

    // Fallback path (test / DB-less envs) — return a simple slice without
    // server-side filter/sort. Prod always uses Prisma.
    if (this.shouldUseFallback()) {
      const rows = await this.supabaseRest<Array<Record<string, any>>>(
        `/cleaning_subscriptions?select=*&deleted_at=is.null&order=created_at.desc&limit=${limit}&offset=${offset}`,
      );
      return {
        rows,
        total: rows.length,
        stats: { total: rows.length, active: 0, pending: 0, paused: 0, cancelled: 0, expired: 0 },
      };
    }

    const rowsSql = `
      SELECT cs.*,
        row_to_json(u.*) AS "user",
        cc.company_name  AS client_name,
        cc.email         AS client_email,
        COALESCE(cp.name, 'Unknown') AS package_name,
        COUNT(*) OVER() AS __total__
      FROM public.cleaning_subscriptions cs
      LEFT JOIN public.users             u  ON u.id::text  = cs.user_id::text
      LEFT JOIN public.cleaning_clients  cc ON cc.id::text = cs.client_id::text
      LEFT JOIN public.cleaning_packages cp ON cp.id       = cs.package_id
      WHERE cs.deleted_at IS NULL
        ${whereStatus}
        ${q ? `AND (u.name ILIKE $1 OR u.display_name ILIKE $1 OR u.email ILIKE $1 OR cp.name ILIKE $1 OR cc.company_name ILIKE $1)` : ""}
      ORDER BY ${orderCol} ${orderDir} NULLS LAST, cs.created_at DESC
      LIMIT ${limit} OFFSET ${offset}
    `;
    const statsSql = `
      SELECT
        COUNT(*)::int AS total,
        COUNT(*) FILTER (WHERE cs.payment_status = 'paid' AND (cs.subscription_status = 'active' OR (cs.is_active AND (cs.subscription_status IS NULL OR cs.subscription_status NOT IN ('paused','cancelled','expired')))))::int AS active,
        COUNT(*) FILTER (WHERE cs.payment_status <> 'paid' AND (cs.subscription_status IS NULL OR cs.subscription_status NOT IN ('cancelled','expired')))::int AS pending,
        COUNT(*) FILTER (WHERE cs.subscription_status = 'paused')::int    AS paused,
        COUNT(*) FILTER (WHERE cs.subscription_status = 'cancelled')::int AS cancelled,
        COUNT(*) FILTER (WHERE cs.subscription_status = 'expired')::int   AS expired
      FROM public.cleaning_subscriptions cs
      WHERE cs.deleted_at IS NULL
    `;

    const [rawRows, statsRows] = await Promise.all([
      q
        ? this.prisma.$queryRawUnsafe<any[]>(rowsSql, `%${q}%`)
        : this.prisma.$queryRawUnsafe<any[]>(rowsSql),
      this.prisma.$queryRawUnsafe<any[]>(statsSql),
    ]);
    const total = rawRows.length > 0 ? Number(rawRows[0].__total__ ?? 0) : 0;
    const rows = rawRows.map(({ __total__, ...r }) => r);
    const stats = statsRows[0] ?? { total: 0, active: 0, pending: 0, paused: 0, cancelled: 0, expired: 0 };
    return { rows, total, stats };
  }

  async listAdminCleaningPackages() {
    if (this.shouldUseFallback()) {
      return this.supabaseRest("/cleaning_packages?select=id,name,price_per_cleaning_cents,monthly_price_cents,cleanings_per_month,frequency_unit,frequency_count,custom_frequency_label,pricing_mode&deleted_at=is.null&order=name.asc");
    }
    return this.prisma.$queryRawUnsafe(
      `SELECT id, name, price_per_cleaning_cents, monthly_price_cents, cleanings_per_month, frequency_unit, frequency_count, custom_frequency_label, pricing_mode
       FROM public.cleaning_packages
       WHERE deleted_at IS NULL
       ORDER BY name`,
    );
  }

  async listUsersForAssignment() {
    if (this.shouldUseFallback()) {
      return this.supabaseRest("/users?select=id,name,display_name,email&deleted_at=is.null&order=email.asc.nullslast&order=created_at.desc");
    }
    return this.prisma.$queryRawUnsafe(
      `SELECT id::text, name, display_name, email
       FROM public.users
       WHERE deleted_at IS NULL
       ORDER BY email NULLS LAST, created_at DESC`,
    );
  }

  async createAdminSubscription(input: Record<string, unknown>, actorUserId: string) {
    const allFields = this.pickSubscriptionFields(input);
    if (!allFields.user_id && !allFields.client_id) {
      throw new BadRequestException("User or client is required.");
    }
    if (!allFields.package_id && !input.one_time) {
      throw new BadRequestException("Plan is required.");
    }
    // Remove null/undefined values — let DB defaults handle them
    const fields: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(allFields)) {
      if (v !== null && v !== undefined) fields[k] = v;
    }

    // Always use Supabase REST for inserts — raw SQL has type casting issues with the pooler
    try {
      const rows = await this.supabaseRest<Array<{ id: string }>>("/cleaning_subscriptions?select=id", {
        method: "POST",
        headers: { Prefer: "return=representation" },
        body: JSON.stringify(fields),
      });
      await this.auditAdminEvent(actorUserId, "create", "subscription", rows[0]?.id ?? null, allFields);
      void this.notifySubscriptionCreated(allFields, rows[0]?.id);
      return rows[0] ?? { ok: true };
    } catch (restError) {
      // Fallback to raw SQL if Supabase REST is not available
      if (!this.prisma.isAvailable()) throw restError;
      const columns = Object.keys(fields);
      const placeholders = columns.map((_, index) => `$${index + 1}`);
      const values = columns.map((column) => fields[column]);
      const rows = await this.prisma.$queryRawUnsafe<Array<{ id: string }>>(
        `INSERT INTO public.cleaning_subscriptions (${columns.join(", ")})
         VALUES (${placeholders.join(", ")})
         RETURNING id`,
        ...values,
      );
      await this.auditAdminEvent(actorUserId, "create", "subscription", rows[0]?.id ?? null, allFields);
      void this.notifySubscriptionCreated(allFields, rows[0]?.id);
      return rows[0] ?? { ok: true };
    }
  }

  private async notifySubscriptionCreated(fields: Record<string, unknown>, subId?: string) {
    try {
      if (!this.accountNotifications) return;
      const recipientId = await this.resolveRecipientUserId(fields);
      if (!recipientId) return;
      const { planName } = await this.resolveSubscriptionNames(fields).catch(() => ({ planName: "your plan" }));
      const paymentStatus = String(fields.payment_status ?? "pending");
      await this.accountNotifications.create({
        recipientUserId: recipientId,
        category: "subscription",
        type: "subscription_created",
        title: "Your plan was created",
        body: `${planName} has been set up for you.`,
        relatedEntityType: "subscription",
        relatedEntityId: subId,
        actionUrl: "/my-subscriptions",
      });
      if (paymentStatus === "paid") {
        await this.accountNotifications.create({
          recipientUserId: recipientId,
          category: "payment",
          type: "payment_received",
          title: "Payment received",
          body: `Your payment for ${planName} has been confirmed.`,
          relatedEntityType: "subscription",
          relatedEntityId: subId,
          actionUrl: "/my-subscriptions",
        });
      } else if (paymentStatus === "pending") {
        await this.accountNotifications.create({
          recipientUserId: recipientId,
          category: "payment",
          type: "payment_pending",
          title: "Payment pending",
          body: `Payment for ${planName} is awaiting confirmation.`,
          relatedEntityType: "subscription",
          relatedEntityId: subId,
          actionUrl: "/my-subscriptions",
        });
      }
    } catch (err) {
      this.logger.warn(`notifySubscriptionCreated failed silently: ${(err as Error).message}`);
    }
  }

  async getSubscriptionBookings(subscriptionId: string) {
    // Load bookings
    const bookings = await this.supabaseRest<any[]>(
      `/cleaning_bookings?select=id,status,reservation_type,source,notes,google_calendar_sync_status,slot_id&or=(cleaning_subscription_id.eq.${encodeURIComponent(subscriptionId)},subscription_id.eq.${encodeURIComponent(subscriptionId)})`,
    );
    if (!bookings.length) return [];

    // Load slots for these bookings
    const slotIds = [...new Set(bookings.map((b: any) => b.slot_id).filter(Boolean))];
    const slots = slotIds.length
      ? await this.supabaseRest<any[]>(
          `/cleaning_available_slots?select=id,date,start_time,end_time&id=in.(${slotIds.join(",")})`,
        )
      : [];
    const slotById = new Map(slots.map((s: any) => [s.id, s]));

    return bookings
      .map((b: any) => ({ ...b, slot: slotById.get(b.slot_id) || null }))
      .sort((a: any, b: any) => {
        const ad = a.slot?.date || "9999";
        const bd = b.slot?.date || "9999";
        return ad.localeCompare(bd) || (a.slot?.start_time || "").localeCompare(b.slot?.start_time || "");
      });
  }

  // ─── Recurrence date generator ─────────────────────────────────────────────

  /**
   * Generate target booking dates for a recurrence pattern.
   * @param days       JS weekday numbers (0=Sun … 6=Sat)
   * @param weeksOfMonth  [1..4, -1=-last] — only for "monthly_weeks"
   */
  private generateReservationDates(
    startDateStr: string,
    endDateStr: string,
    days: number[],
    recurrenceType: "weekly" | "biweekly" | "monthly_weeks",
    weeksOfMonth: number[] = [],
  ): string[] {
    const start = new Date(`${startDateStr}T00:00:00`);
    const end   = new Date(`${endDateStr}T00:00:00`);
    const seen  = new Set<string>();
    const push  = (d: Date) => {
      const s = d.toISOString().slice(0, 10);
      if (!seen.has(s)) { seen.add(s); }
    };

    if (recurrenceType === "monthly_weeks") {
      if (!days.length || !weeksOfMonth.length) return [];
      const cur = new Date(start.getFullYear(), start.getMonth(), 1);
      while (cur <= end) {
        const y = cur.getFullYear(), m = cur.getMonth();
        const daysInMonth = new Date(y, m + 1, 0).getDate();
        for (const dow of days) {
          for (const weekNum of weeksOfMonth) {
            if (weekNum === -1) {
              // Last occurrence
              for (let d = daysInMonth; d >= 1; d--) {
                const dt = new Date(y, m, d);
                if (dt.getDay() === dow && dt >= start && dt <= end) { push(dt); break; }
              }
            } else {
              let count = 0;
              for (let d = 1; d <= daysInMonth; d++) {
                const dt = new Date(y, m, d);
                if (dt.getDay() === dow) {
                  count++;
                  if (count === weekNum && dt >= start && dt <= end) { push(dt); break; }
                }
              }
            }
          }
        }
        cur.setMonth(cur.getMonth() + 1);
      }
      return [...seen].sort();
    }

    // Weekly / biweekly — generate per weekday independently
    for (const dow of days) {
      // Advance to first occurrence of this weekday on or after start
      const cursor = new Date(start);
      while (cursor.getDay() !== dow) cursor.setDate(cursor.getDate() + 1);
      let occurrence = 0;
      while (cursor <= end) {
        const isEven = occurrence % 2 === 0;
        if (recurrenceType === "weekly" || isEven) push(new Date(cursor));
        cursor.setDate(cursor.getDate() + 7);
        occurrence++;
      }
    }
    return [...seen].sort();
  }

  async createSubscriptionWithReservations(input: Record<string, unknown>, actorUserId: string) {
    // 1. Create or reuse subscription
    let subResult: any;
    let subscriptionId: string;

    if (input._existing_subscription_id) {
      subscriptionId = String(input._existing_subscription_id);
      subResult = { id: subscriptionId, reused: true };
    } else {
      subResult = await this.createAdminSubscription(input, actorUserId);
      subscriptionId = subResult.id;
    }
    if (!subscriptionId) return subResult;

    const reservations = input.reservations as any;
    if (!reservations?.enabled) return { ...subResult, bookings_created: 0 };

    const days = (reservations.days_of_week as number[]) || [];
    const startTime = String(reservations.start_time || "08:00:00");
    const endTime = String(reservations.end_time || "09:45:00");
    const reservationType = String(reservations.reservation_type || "booking_reserved");
    const blockCapacity = reservations.block_capacity !== false;
    const syncCalendar = reservations.sync_calendar !== false;
    const startDate = String(input.start_date || input.service_start_date || new Date().toISOString().slice(0, 10));
    const endDate = String(reservations.end_date || input.end_date || input.service_end_date || startDate);
    const notes = String(input.apartment_note || reservations.notes || "");
    const userId = input.user_id ? String(input.user_id) : null;
    const clientId = input.client_id ? String(input.client_id) : null;
    const recurrenceType = (reservations.recurrence_type as "weekly" | "biweekly" | "monthly_weeks") || "weekly";
    const weeksOfMonth = (reservations.weeks_of_month as number[]) || [];

    if (!days.length) return { ...subResult, bookings_created: 0 };
    if (recurrenceType === "monthly_weeks" && !weeksOfMonth.length) return { ...subResult, bookings_created: 0 };

    // 2. Load capacity settings
    const settings = await this.supabaseRest<Array<{ key: string; value: unknown }>>(
      "/global_settings?select=key,value&key=in.(default_slot_capacity,saturday_slot_capacity)",
    );
    const settingsMap = new Map(settings.map((s) => [s.key, s.value]));
    const defaultCap = Math.max(1, Number(settingsMap.get("default_slot_capacity")) || 1);
    const saturdayCap = Math.max(1, Number(settingsMap.get("saturday_slot_capacity")) || defaultCap);

    const normalizedStart = startTime.length === 5 ? `${startTime}:00` : startTime;
    const normalizedEnd = endTime.length === 5 ? `${endTime}:00` : endTime;

    // 3. Generate target dates using the recurrence engine
    const targetDates = this.generateReservationDates(startDate, endDate, days, recurrenceType, weeksOfMonth);
    if (!targetDates.length) return { ...subResult, bookings_created: 0 };

    // Load existing slots for the period
    const existingSlots = await this.supabaseRest<any[]>(
      `/cleaning_available_slots?select=*&date=gte.${startDate}&date=lte.${endDate}&start_time=eq.${normalizedStart}&end_time=eq.${normalizedEnd}`,
    );
    const slotByDate = new Map(existingSlots.map((s: any) => [s.date, s]));

    const bookings: any[] = [];
    const conflicts: string[] = [];

    for (const dateStr of targetDates) {
      const dow = new Date(`${dateStr}T00:00:00`).getDay();
      {
        let slot = slotByDate.get(dateStr);

        if (!slot) {
          // Create slot
          const capacity = dow === 6 ? saturdayCap : defaultCap;
          const created = await this.supabaseRest<any[]>("/cleaning_available_slots?select=*", {
            method: "POST",
            headers: { Prefer: "return=representation" },
            body: JSON.stringify({
              id: `slot-${dateStr}-${normalizedStart.slice(0, 5).replace(":", "")}`,
              date: dateStr,
              start_time: normalizedStart,
              end_time: normalizedEnd,
              max_bookings: capacity,
              current_bookings: 0,
              is_active: true,
            }),
          });
          slot = created[0];
        }

        if (blockCapacity && slot && slot.current_bookings >= slot.max_bookings) {
          conflicts.push(dateStr);
        } else {
          bookings.push({
            slot_id: slot?.id,
            user_id: userId || actorUserId,
            client_id: clientId,
            cleaning_subscription_id: subscriptionId,
            subscription_id: subscriptionId,
            status: reservationType === "confirmed_booking" ? "booked" : "booked",
            reservation_type: reservationType,
            source: "admin_reservation",
            notes,
            google_calendar_sync_status: syncCalendar ? "pending" : "skipped",
          });

          if (blockCapacity && slot) {
            await this.supabaseRest(`/cleaning_available_slots?id=eq.${encodeURIComponent(slot.id)}`, {
              method: "PATCH",
              body: JSON.stringify({
                current_bookings: (slot.current_bookings || 0) + 1,
                updated_at: new Date().toISOString(),
              }),
            });
          }
        }
      }
    }

    // 4. Insert bookings and get IDs
    const createdBookingIds: string[] = [];
    if (bookings.length) {
      const created = await this.supabaseRest<Array<{ id: string }>>("/cleaning_bookings?select=id", {
        method: "POST",
        headers: { Prefer: "return=representation" },
        body: JSON.stringify(bookings),
      });
      for (const b of created) createdBookingIds.push(b.id);
    }

    // 5. Schedule access reminders for newly created bookings
    if (createdBookingIds.length && this.cleaningReminders) {
      void this.cleaningReminders.scheduleForBookings(createdBookingIds).catch((err) =>
        this.logger.warn(`Reminder scheduling failed: ${(err as Error).message}`),
      );
    }

    // 6. Calendar sync — sync each created booking
    if (syncCalendar && createdBookingIds.length && this.cleaningCalendarSync.isConfigured()) {
      const syncResults = await this.syncBookingsToCalendar(createdBookingIds);
      const failed = syncResults.filter((r) => !r.ok).length;
      if (failed > 0) {
        // Log but don't fail the whole operation
        console.warn(`Calendar sync: ${failed}/${syncResults.length} bookings failed`);
      }
    }

    await this.auditAdminEvent(actorUserId, "create_with_reservations", "subscription", subscriptionId, {
      bookings_created: bookings.length,
      conflicts,
      reservation_type: reservationType,
      days_of_week: days,
    });

    return {
      ...subResult,
      bookings_created: bookings.length,
      conflicts,
      reservation_type: reservationType,
    };
  }

  async updateAdminSubscription(id: string, input: Record<string, unknown>, action: string | undefined, actorUserId: string) {
    const fields = this.pickSubscriptionFields(input);
    const columns = Object.keys(fields);
    if (!columns.length) return { ok: true };

    // Fetch subscription before update (no deleted_at filter — admins can edit cancelled subs too)
    let subBefore: Record<string, any> | null = null;
    try {
      const rows = await this.supabaseRest<Array<Record<string, any>>>(
        `/cleaning_subscriptions?select=id,user_id,client_id,package_id,payment_status,subscription_status&id=eq.${encodeURIComponent(id)}&limit=1`,
      );
      subBefore = rows[0] ?? null;
    } catch { /* non-blocking */ }

    try {
      // Always use Supabase REST for updates — no deleted_at filter so cancelled subs can be edited
      await this.supabaseRest(`/cleaning_subscriptions?id=eq.${encodeURIComponent(id)}`, {
        method: "PATCH",
        body: JSON.stringify({ ...fields, updated_at: new Date().toISOString() }),
      });
    } catch (err) {
      // Fallback: try Prisma raw query
      if (this.prisma.isAvailable()) {
        try {
          const assignments = columns.map((col, i) => `${col} = $${i + 2}`);
          const values = columns.map((col) => fields[col]);
          await this.prisma.$executeRawUnsafe(
            `UPDATE public.cleaning_subscriptions SET ${assignments.join(", ")}, updated_at = now() WHERE id = $1`,
            id, ...values,
          );
        } catch (prismaErr) {
          this.logger.error(`updateAdminSubscription Prisma fallback failed: ${(prismaErr as Error).message}`);
          throw prismaErr;
        }
      } else {
        this.logger.error(`updateAdminSubscription Supabase REST failed: ${(err as Error).message}`);
        throw err;
      }
    }

    await this.auditAdminEvent(actorUserId, action || "edit", "subscription", id, fields);
    void this.notifySubscriptionUpdated(subBefore, fields, id);
    return { ok: true };
  }

  /**
   * Cancel a subscription and all its future booked cleaning sessions.
   * Also removes the corresponding Google Calendar events.
   */
  async cancelSubscription(subscriptionId: string, actorUserId: string) {
    // 1. Mark subscription as cancelled
    await this.supabaseRest(`/cleaning_subscriptions?id=eq.${encodeURIComponent(subscriptionId)}`, {
      method: "PATCH",
      body: JSON.stringify({ subscription_status: "cancelled", is_active: false, updated_at: new Date().toISOString() }),
    });

    // 2. Find all booked slots for this subscription via two separate queries (OR filter is unreliable)
    const today = new Date().toISOString().slice(0, 10);
    let futureBookings: any[] = [];
    try {
      const [bySubId, byCleaningSubId] = await Promise.all([
        this.supabaseRest<any[]>(
          `/cleaning_bookings?select=id,google_calendar_event_id,slot_id,cleaning_available_slots(date)&subscription_id=eq.${encodeURIComponent(subscriptionId)}&status=eq.booked`,
        ).catch(() => [] as any[]),
        this.supabaseRest<any[]>(
          `/cleaning_bookings?select=id,google_calendar_event_id,slot_id,cleaning_available_slots(date)&cleaning_subscription_id=eq.${encodeURIComponent(subscriptionId)}&status=eq.booked`,
        ).catch(() => [] as any[]),
      ]);
      // Merge & deduplicate
      const seen = new Set<string>();
      for (const b of [...bySubId, ...byCleaningSubId]) {
        if (!seen.has(b.id)) { seen.add(b.id); futureBookings.push(b); }
      }
      // Keep only future bookings
      futureBookings = futureBookings.filter(
        (b) => (b.cleaning_available_slots?.date ?? today) >= today,
      );
    } catch (err) {
      this.logger.warn(`cancelSubscription: could not load bookings: ${(err as Error).message}`);
    }

    // 3. Cancel bookings — use two targeted PATCHes (same pattern, no OR)
    if (futureBookings.length) {
      await Promise.all([
        this.supabaseRest(
          `/cleaning_bookings?subscription_id=eq.${encodeURIComponent(subscriptionId)}&status=eq.booked`,
          { method: "PATCH", body: JSON.stringify({ status: "cancelled", updated_at: new Date().toISOString() }) },
        ).catch((e) => this.logger.warn(`cancelSubscription PATCH by subscription_id: ${(e as Error).message}`)),
        this.supabaseRest(
          `/cleaning_bookings?cleaning_subscription_id=eq.${encodeURIComponent(subscriptionId)}&status=eq.booked`,
          { method: "PATCH", body: JSON.stringify({ status: "cancelled", updated_at: new Date().toISOString() }) },
        ).catch((e) => this.logger.warn(`cancelSubscription PATCH by cleaning_subscription_id: ${(e as Error).message}`)),
      ]);

      // 4. Decrement slot current_bookings for freed capacity
      await this.decrementSlotBookings(futureBookings.map((b) => b.slot_id).filter(Boolean));

      // 5. Remove Google Calendar events
      if (this.cleaningCalendarSync.isConfigured()) {
        for (const booking of futureBookings) {
          try {
            await this.cleaningCalendarSync.deleteCalendarEventForBooking(booking.id);
            this.logger.log(`[cancel] Removed calendar event for booking ${booking.id}`);
          } catch (e) {
            this.logger.warn(`[cancel] Could not remove calendar event for booking ${booking.id}: ${(e as Error).message}`);
          }
        }
      }
    }

    await this.auditAdminEvent(actorUserId, "cancel", "subscription", subscriptionId, {
      bookings_cancelled: futureBookings.length,
    });

    // 5. Notify user
    void this.notifySubscriptionUpdated(null, { subscription_status: "cancelled", user_id: null }, subscriptionId).catch(() => {});

    return { ok: true, bookings_cancelled: futureBookings.length };
  }

  /** Returns the subscription if it belongs to this user directly or via a linked client. */
  async getSubscriptionForUser(userId: string, subscriptionId: string): Promise<Record<string, any> | null> {
    try {
      const rows = await this.supabaseRest<any[]>(
        `/cleaning_subscriptions?select=id,user_id,client_id,payment_status,subscription_status&id=eq.${encodeURIComponent(subscriptionId)}&limit=1`,
      );
      const sub = rows?.[0];
      if (!sub) return null;
      // Direct user match
      if (sub.user_id === userId) return sub;
      // Check via linked client
      if (sub.client_id) {
        const clients = await this.supabaseRest<any[]>(
          `/cleaning_clients?select=user_id&id=eq.${encodeURIComponent(sub.client_id)}&limit=1`,
        );
        if (clients?.[0]?.user_id === userId) return sub;
      }
      return null;
    } catch {
      return null;
    }
  }

  private async notifySubscriptionUpdated(
    subBefore: Record<string, any> | null,
    fields: Record<string, unknown>,
    subId: string,
  ) {
    try {
      if (!this.accountNotifications || !subBefore) return;
      const recipientId = await this.resolveRecipientUserId(subBefore);
      if (!recipientId) return;
      const { planName } = await this.resolveSubscriptionNames(subBefore).catch(() => ({ planName: "your plan" }));

      const newPaymentStatus = fields.payment_status ? String(fields.payment_status) : null;
      const newSubStatus = fields.subscription_status ? String(fields.subscription_status) : null;
      const prevPaymentStatus = subBefore.payment_status ? String(subBefore.payment_status) : null;
      const prevSubStatus = subBefore.subscription_status ? String(subBefore.subscription_status) : null;

      if (newPaymentStatus === "paid" && prevPaymentStatus !== "paid") {
        await this.accountNotifications.create({
          recipientUserId: recipientId,
          category: "payment",
          type: "payment_received",
          title: "Payment received",
          body: `Your payment for ${planName} has been confirmed.`,
          relatedEntityType: "subscription",
          relatedEntityId: subId,
          actionUrl: "/my-subscriptions",
        });
      } else if (newPaymentStatus === "pending" && prevPaymentStatus !== "pending") {
        await this.accountNotifications.create({
          recipientUserId: recipientId,
          category: "payment",
          type: "payment_pending",
          title: "Payment pending",
          body: `Payment for ${planName} is awaiting confirmation.`,
          relatedEntityType: "subscription",
          relatedEntityId: subId,
          actionUrl: "/my-subscriptions",
        });
      }

      if (
        (newSubStatus === "cancelled" || newSubStatus === "canceled") &&
        prevSubStatus !== "cancelled" && prevSubStatus !== "canceled"
      ) {
        await this.accountNotifications.create({
          recipientUserId: recipientId,
          category: "subscription",
          type: "plan_cancelled",
          title: "Subscription cancelled",
          body: `Your ${planName} subscription has been cancelled.`,
          relatedEntityType: "subscription",
          relatedEntityId: subId,
          actionUrl: "/my-subscriptions",
        });
      }

      if (newSubStatus === "active" && prevSubStatus !== "active" && newPaymentStatus !== "paid") {
        await this.accountNotifications.create({
          recipientUserId: recipientId,
          category: "subscription",
          type: "subscription_created",
          title: "Subscription activated",
          body: `${planName} is now active.`,
          relatedEntityType: "subscription",
          relatedEntityId: subId,
          actionUrl: "/my-subscriptions",
        });
      }
    } catch (err) {
      this.logger.warn(`notifySubscriptionUpdated failed silently: ${(err as Error).message}`);
    }
  }

  /**
   * Server-side reconciliation: find cleaning subscriptions that have a payment
   * reference but aren't marked paid, check the provider, and activate the paid
   * ones. Runs from a cron so activation happens without any manual action.
   */
  async reconcilePendingPayments(): Promise<{ checked: number; activated: number }> {
    // Reconcile pending payments across cleaning / food / beach subscriptions,
    // dispatching to the right provider (Blink Lightning/on-chain OR SimpleFi
    // for LIVES). PayPal is captured client-side at checkout and does not need
    // background reconciliation. Runs from cron so activation is automatic.
    const scopes = [
      { table: "cleaning_subscriptions", statusCol: "subscription_status", extraFilters: "&deleted_at=is.null" },
      { table: "food_subscriptions",     statusCol: "status",              extraFilters: "" },
      { table: "beach_club_subscriptions", statusCol: "status",            extraFilters: "" },
    ] as const;

    const checkPaid = async (sub: Record<string, any>): Promise<boolean> => {
      const method = String(sub.payment_method || "");
      const ref = String(sub.payment_reference || "");
      if (!ref) return false;
      if (method === "onchain" && this.blink) return (await this.blink.getOnchainStatus(ref)).paid;
      if ((method === "lightning" || method === "blink") && this.blink) return (await this.blink.getPaymentStatus(ref)).paid;
      if ((method === "infinita" || method === "crypto") && this.simplefi) {
        const s = await this.simplefi.getPaymentStatus(ref);
        return s.status === "paid";
      }
      return false;
    };

    let totalChecked = 0;
    let activated = 0;

    for (const scope of scopes) {
      let rows: Array<Record<string, any>> = [];
      try {
        rows = await this.supabaseRest<Array<Record<string, any>>>(
          `/${scope.table}?select=*&payment_status=neq.paid&payment_reference=not.is.null&${scope.statusCol}=neq.cancelled${scope.extraFilters}&limit=200`,
        );
      } catch {
        continue;
      }
      totalChecked += rows.length;

      for (const sub of rows) {
        try {
          const paid = await checkPaid(sub);
          if (!paid) continue;

          const patch: Record<string, any> = {
            payment_status: "paid",
            updated_at: new Date().toISOString(),
          };
          if (scope.table === "cleaning_subscriptions") {
            patch.subscription_status = "active";
            patch.is_active = true;
          } else {
            patch.status = "active";
          }

          await this.supabaseRest(
            `/${scope.table}?id=eq.${encodeURIComponent(sub.id)}`,
            { method: "PATCH", body: JSON.stringify(patch) },
          );
          void this.notifySubscriptionUpdated(sub, { payment_status: "paid" }, sub.id);

          // Billing domain: record + emit billing.PaymentCaptured from the same
          // single place as interactive checkouts (idempotent per provider+ref).
          const billingMethod = this.billingMethodOf(sub.payment_method);
          if (billingMethod && this.billing) {
            await this.billing.recordCaptured({
              method: billingMethod,
              provider: billingMethod === "lives" ? "simplefi" : "blink",
              providerRef: String(sub.payment_reference),
              amountCents: this.subAmountCents(scope.table, sub),
              subjectRef: `subscription:${sub.id}`,
              metadata: { table: scope.table, reconciled: true },
            }).catch((e) => this.logger.warn(`billing.recordCaptured failed for ${sub.id}: ${(e as Error).message}`));
          }
          activated++;
        } catch {
          // skip this sub, continue with the rest of the scan
        }
      }
    }
    return { checked: totalChecked, activated };
  }

  async createSubscriptionInvoice(subscriptionId: string, method: "lightning" | "onchain" = "lightning") {
    if (!this.blink) {
      throw new BadRequestException("Payment provider is not configured.");
    }

    const rows = await this.supabaseRest<Array<Record<string, any>>>(
      `/cleaning_subscriptions?select=*&id=eq.${encodeURIComponent(subscriptionId)}&deleted_at=is.null&limit=1`,
    );
    const sub = rows[0];
    if (!sub) throw new NotFoundException("Subscription not found.");
    if (sub.payment_status === "paid") {
      throw new BadRequestException("This subscription is already paid.");
    }

    const amountCents = Number(sub.total_price_cents) || Number(sub.monthly_price_cents) || 0;
    if (amountCents <= 0) {
      throw new BadRequestException("Subscription has no amount to charge.");
    }

    const { planName, clientName } = await this.resolveSubscriptionNames(sub);

    // ── On-chain Bitcoin (Blink) ──────────────────────────────────────────────
    if (method === "onchain") {
      // Reuse + reconcile an existing on-chain address if one is set.
      if (sub.payment_reference && sub.payment_method === "onchain") {
        try {
          const status = await this.blink.getOnchainStatus(sub.payment_reference);
          if (status.paid) {
            await this.supabaseRest(
              `/cleaning_subscriptions?id=eq.${encodeURIComponent(subscriptionId)}`,
              { method: "PATCH", body: JSON.stringify({ payment_status: "paid", subscription_status: "active", is_active: true, updated_at: new Date().toISOString() }) },
            );
            if (sub.payment_status !== "paid") void this.notifySubscriptionUpdated(sub, { payment_status: "paid" }, subscriptionId);
            return { subscription_id: subscriptionId, address: sub.payment_reference, amount_cents: amountCents, plan_name: planName, client_name: clientName, method: "onchain", status: "paid" };
          }
          return { subscription_id: subscriptionId, address: sub.payment_reference, amount_cents: amountCents, plan_name: planName, client_name: clientName, method: "onchain", status: "pending" };
        } catch {
          // fall through to create a fresh address
        }
      }

      const onchain = await this.blink.createOnchainAddress({ memo: `${planName} — ${clientName}` });
      await this.supabaseRest(
        `/cleaning_subscriptions?id=eq.${encodeURIComponent(subscriptionId)}`,
        { method: "PATCH", body: JSON.stringify({ payment_reference: onchain.address, payment_method: "onchain", updated_at: new Date().toISOString() }) },
      );
      void this.notifySubscriptionUpdated(sub, { payment_status: "pending" }, subscriptionId);
      return { subscription_id: subscriptionId, address: onchain.address, amount_cents: amountCents, plan_name: planName, client_name: clientName, method: "onchain", status: "pending" };
    }

    // If an invoice already exists, check its status and return it
    if (sub.payment_reference) {
      try {
        const status = await this.blink.getPaymentStatus(sub.payment_reference);
        if (status.paid) {
          await this.supabaseRest(
            `/cleaning_subscriptions?id=eq.${encodeURIComponent(subscriptionId)}`,
            {
              method: "PATCH",
              body: JSON.stringify({ payment_status: "paid", subscription_status: "active", is_active: true, updated_at: new Date().toISOString() }),
            },
          );
          if (sub.payment_status !== "paid") {
            void this.notifySubscriptionUpdated(sub, { payment_status: "paid" }, subscriptionId);
          }
          return { subscription_id: subscriptionId, payment_hash: sub.payment_reference, payment_request: status.payment_request, amount_cents: amountCents, plan_name: planName, client_name: clientName, status: "paid" };
        }
        if (status.payment_request) {
          return { subscription_id: subscriptionId, payment_hash: sub.payment_reference, payment_request: status.payment_request, amount_cents: amountCents, plan_name: planName, client_name: clientName, status: "pending" };
        }
      } catch {
        // Existing invoice expired or invalid — create a new one below
      }
    }

    // Create new invoice with unique externalId (append timestamp to avoid duplicates)
    const invoice = await this.blink.createUsdInvoice({
      amountCents,
      memo: `${planName} — ${clientName}`,
      externalId: `sub-${subscriptionId}-${Date.now()}`,
    });

    await this.supabaseRest(
      `/cleaning_subscriptions?id=eq.${encodeURIComponent(subscriptionId)}`,
      {
        method: "PATCH",
        body: JSON.stringify({
          payment_reference: invoice.payment_hash,
          payment_method: "lightning",
          updated_at: new Date().toISOString(),
        }),
      },
    );

    // Notify user: payment invoice created / payment pending
    void this.notifySubscriptionUpdated(sub, { payment_status: "pending" }, subscriptionId);

    return {
      subscription_id: subscriptionId,
      payment_hash: invoice.payment_hash,
      payment_request: invoice.payment_request,
      amount_cents: amountCents,
      amount_sats: invoice.amount_sats,
      plan_name: planName,
      client_name: clientName,
      status: "pending",
    };
  }

  /** Resolve the user ID to notify for a subscription row (direct user or linked client user). */
  private async resolveRecipientUserId(sub: Record<string, any>): Promise<string | null> {
    if (sub.user_id) return String(sub.user_id);
    if (sub.client_id) {
      try {
        const clients = await this.supabaseRest<Array<{ user_id: string | null }>>(
          `/cleaning_clients?select=user_id&id=eq.${encodeURIComponent(sub.client_id)}&limit=1`,
        );
        return clients[0]?.user_id ?? null;
      } catch {
        return null;
      }
    }
    return null;
  }

  private async resolveSubscriptionNames(sub: Record<string, any>) {
    const packages = await this.supabaseRest<Array<{ name: string }>>(
      `/cleaning_packages?select=name&id=eq.${encodeURIComponent(sub.package_id)}&limit=1`,
    );
    const planName = packages[0]?.name ?? "Cleaning subscription";

    let clientName = "Client";
    if (sub.client_id) {
      const clients = await this.supabaseRest<Array<{ company_name: string }>>(
        `/cleaning_clients?select=company_name&id=eq.${encodeURIComponent(sub.client_id)}&limit=1`,
      );
      clientName = clients[0]?.company_name ?? clientName;
    } else if (sub.user_id) {
      const users = await this.supabaseRest<Array<{ name: string; display_name: string; email: string }>>(
        `/users?select=name,display_name,email&id=eq.${encodeURIComponent(sub.user_id)}&limit=1`,
      );
      clientName = users[0]?.display_name || users[0]?.name || users[0]?.email || clientName;
    }
    return { planName, clientName };
  }

  async getAdminPaymentStats() {
    if (this.shouldUseFallback()) {
      const rows = await this.supabaseRest<Array<{ payment_status: string | null; total_price_cents: number | null }>>(
        "/cleaning_subscriptions?select=payment_status,total_price_cents&deleted_at=is.null",
      );
      const paid = rows.filter((row) => row.payment_status === "paid");
      return {
        pending: rows.filter((row) => row.payment_status === "pending").length,
        paid: paid.length,
        revenueCents: paid.reduce((sum, row) => sum + (row.total_price_cents ?? 0), 0),
      };
    }
    const rows = await this.prisma.$queryRawUnsafe<Array<{ pending: number; paid: number; revenue_cents: number }>>(
      `SELECT
         COUNT(*) FILTER (WHERE payment_status = 'pending')::int AS pending,
         COUNT(*) FILTER (WHERE payment_status = 'paid')::int AS paid,
         COALESCE(SUM(total_price_cents) FILTER (WHERE payment_status = 'paid'), 0)::int AS revenue_cents
       FROM public.cleaning_subscriptions
       WHERE deleted_at IS NULL`,
    );
    const row = rows[0] ?? { pending: 0, paid: 0, revenue_cents: 0 };
    return { pending: row.pending, paid: row.paid, revenueCents: row.revenue_cents };
  }

  // Service categories that can be shown/hidden from regular users.
  private static readonly CATEGORY_KEYS = [
    "category_food_visible",
    "category_cars_visible",
    "category_cleaning_visible",
    "category_beach_visible",
    "category_massage_visible",
  ] as const;

  private static readonly BOOLEAN_FLAG_KEYS = [
    "lives_direct_enabled",
  ] as const;

  async getPlatformSettings() {
    const keys = [
      "min_subscription_weeks", "max_subscription_weeks", "platform_fee_percent",
      "finance_cleaning_cost_cents", "finance_beach_extra_cents",
      "finance_car_commission_pct", "finance_food_commission_pct",
      "finance_cleaning_type", "finance_beach_type",
      "finance_car_type", "finance_food_type",
      ...AdminService.CATEGORY_KEYS,
      ...AdminService.BOOLEAN_FLAG_KEYS,
    ];
    const keyList = keys.map((k) => `'${k}'`).join(", ");

    let values = new Map<string, unknown>();
    if (this.shouldUseFallback()) {
      const rows = await this.supabaseRest<Array<{ key: string; value: unknown }>>(
        `/global_settings?select=key,value&key=in.(${keys.join(",")})`,
      );
      values = new Map(rows.map((row) => [row.key, row.value]));
    } else {
      const rows = await this.prisma.$queryRawUnsafe<Array<{ key: string; value: unknown }>>(
        `SELECT key, value FROM public.global_settings WHERE key IN (${keyList})`,
      );
      values = new Map(rows.map((row) => [row.key, row.value]));
    }

    // Categories default to visible when no setting has been saved yet.
    const bool = (v: unknown, d = true) => (v === undefined || v === null ? d : v === true || v === "true");
    return {
      min_subscription_weeks: Number(values.get("min_subscription_weeks") ?? 1),
      max_subscription_weeks: Number(values.get("max_subscription_weeks") ?? 4),
      platform_fee_percent: Number(values.get("platform_fee_percent") ?? 0),
      category_food_visible: bool(values.get("category_food_visible")),
      category_cars_visible: bool(values.get("category_cars_visible")),
      category_cleaning_visible: bool(values.get("category_cleaning_visible")),
      category_beach_visible: bool(values.get("category_beach_visible")),
      category_massage_visible: bool(values.get("category_massage_visible")),
      // Financial / profit configuration (cents and whole-percent values).
      finance_cleaning_cost_cents: Number(values.get("finance_cleaning_cost_cents") ?? 75000),
      finance_beach_extra_cents: Number(values.get("finance_beach_extra_cents") ?? 1000),
      finance_car_commission_pct: Number(values.get("finance_car_commission_pct") ?? 10),
      finance_food_commission_pct: Number(values.get("finance_food_commission_pct") ?? 10),
      // How each source's value is interpreted: "percent" | "fixed" | "person".
      finance_cleaning_type: String(values.get("finance_cleaning_type") ?? "fixed"),
      finance_beach_type: String(values.get("finance_beach_type") ?? "person"),
      finance_car_type: String(values.get("finance_car_type") ?? "percent"),
      finance_food_type: String(values.get("finance_food_type") ?? "percent"),
      lives_direct_enabled: bool(values.get("lives_direct_enabled")),
    };
  }

  async updatePlatformSettings(input: Record<string, unknown>, actorUserId: string) {
    // Only persist the keys actually provided — this keeps partial updates safe
    // (e.g. toggling category visibility must not reset the subscription-week settings).
    const updates: Record<string, unknown> = {};
    for (const key of [
      "min_subscription_weeks", "max_subscription_weeks", "platform_fee_percent",
      "finance_cleaning_cost_cents", "finance_beach_extra_cents",
      "finance_car_commission_pct", "finance_food_commission_pct",
    ]) {
      if (input[key] !== undefined) updates[key] = Number(input[key]);
    }
    for (const key of [
      "finance_cleaning_type", "finance_beach_type",
      "finance_car_type", "finance_food_type",
    ]) {
      if (input[key] !== undefined) updates[key] = String(input[key]);
    }
    for (const key of AdminService.CATEGORY_KEYS) {
      if (input[key] !== undefined) updates[key] = Boolean(input[key]);
    }
    for (const key of AdminService.BOOLEAN_FLAG_KEYS) {
      if (input[key] !== undefined) updates[key] = Boolean(input[key]);
    }
    if (Object.keys(updates).length === 0) return this.getPlatformSettings();

    if (this.shouldUseFallback()) {
      await this.supabaseRest("/global_settings?on_conflict=key", {
        method: "POST",
        headers: { Prefer: "resolution=merge-duplicates,return=representation" },
        body: JSON.stringify(Object.entries(updates).map(([key, value]) => ({ key, value }))),
      });
    } else {
      for (const [key, value] of Object.entries(updates)) {
        await this.prisma.$executeRawUnsafe(
          `INSERT INTO public.global_settings (key, value)
           VALUES ($1, $2::jsonb)
           ON CONFLICT (key)
           DO UPDATE SET value = EXCLUDED.value, updated_at = now()`,
          key,
          JSON.stringify(value),
        );
      }
    }
    await this.auditAdminEvent(actorUserId, "edit", "settings", "platform", updates);
    return this.getPlatformSettings();
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
          orderBy: { slot: { date: "asc" } },
        },
        completionReports: {
          orderBy: { completedAt: "desc" },
        },
      },
    });
  }

  async getSlotCapacitySettings() {
    const rows = await this.supabaseRest<Array<{ key: string; value: unknown }>>(
      "/global_settings?select=key,value&key=in.(default_slot_capacity,saturday_slot_capacity)",
    );
    const values = new Map(rows.map((r) => [r.key, r.value]));
    return {
      default_slot_capacity: Number(values.get("default_slot_capacity") ?? 1),
      saturday_slot_capacity: Number(values.get("saturday_slot_capacity") ?? 1),
    };
  }

  async updateSlotCapacitySettings(
    input: { default_slot_capacity?: number; saturday_slot_capacity?: number; apply_to_future?: boolean },
    actorUserId: string,
  ) {
    const defaultCap = Math.max(1, Number(input.default_slot_capacity) || 1);
    const saturdayCap = Math.max(1, Number(input.saturday_slot_capacity) || defaultCap);

    for (const [key, value] of [["default_slot_capacity", defaultCap], ["saturday_slot_capacity", saturdayCap]] as const) {
      await this.supabaseRest("/global_settings?on_conflict=key", {
        method: "POST",
        headers: { Prefer: "resolution=merge-duplicates,return=representation" },
        body: JSON.stringify({ key, value }),
      });
    }

    let updatedSlots = 0;
    if (input.apply_to_future) {
      const today = new Date().toISOString().slice(0, 10);
      // Update weekday slots (Mon-Fri)
      const weekdayResult = await this.supabaseRest<any>(
        `/cleaning_available_slots?date=gte.${today}&current_bookings=lt.${defaultCap}`,
        {
          method: "PATCH",
          headers: { Prefer: "return=representation" },
          body: JSON.stringify({ max_bookings: defaultCap, updated_at: new Date().toISOString() }),
        },
      );
      updatedSlots += Array.isArray(weekdayResult) ? weekdayResult.length : 0;
    }

    await this.auditAdminEvent(actorUserId, "edit", "settings", "slot_capacity", {
      default_slot_capacity: defaultCap,
      saturday_slot_capacity: saturdayCap,
      apply_to_future: input.apply_to_future,
    });

    return { default_slot_capacity: defaultCap, saturday_slot_capacity: saturdayCap, updated_slots: updatedSlots };
  }

  async updateSlotCapacity(slotId: string, maxBookings: number) {
    const capacity = Math.max(1, Math.round(maxBookings));
    // Check current bookings don't exceed new capacity
    const slots = await this.supabaseRest<Array<{ current_bookings: number }>>(
      `/cleaning_available_slots?select=current_bookings&id=eq.${encodeURIComponent(slotId)}&limit=1`,
    );
    const slot = slots[0];
    if (!slot) throw new NotFoundException("Slot not found.");
    if (slot.current_bookings > capacity) {
      throw new BadRequestException(`Cannot reduce capacity to ${capacity} — ${slot.current_bookings} bookings already exist.`);
    }
    await this.supabaseRest(`/cleaning_available_slots?id=eq.${encodeURIComponent(slotId)}`, {
      method: "PATCH",
      body: JSON.stringify({ max_bookings: capacity, updated_at: new Date().toISOString() }),
    });
    return { id: slotId, max_bookings: capacity };
  }

  async listCleaningClientsSimple() {
    if (this.shouldUseFallback()) {
      return this.supabaseRest<any[]>("/cleaning_clients?select=id,company_name,email,phone,location,status&deleted_at=is.null&order=company_name.asc");
    }
    return this.prisma.cleaningClient.findMany({
      where: { deletedAt: null },
      select: { id: true, companyName: true, email: true, phone: true, location: true, status: true },
      orderBy: { companyName: "asc" },
    });
  }

  async listCleaningClients() {
    if (this.shouldUseFallback()) {
      return this.listCleaningClientsSimple();
    }

    const [clients, subscriptions] = await Promise.all([
      this.prisma.cleaningClient.findMany({
        where: { deletedAt: null },
        orderBy: { createdAt: "desc" },
        take: AdminService.ADMIN_LIST_HARD_CAP,
        include: {
          customPlans: true,
          recurringSchedules: true,
          bookings: {
            include: { slot: true },
            orderBy: { slot: { date: "desc" } },
            take: 50,
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
            orderBy: { slot: { date: "desc" } },
          },
        },
      }),
    ]);

    const publicSubscriptionsByEmail = new Map<string, typeof subscriptions>();
    for (const subscription of subscriptions) {
      const email = this.normalizeLookup(subscription.user?.email);
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
        lastServiceDate: lastBooking?.slot.date ?? null,
        isDerived: false,
      };
    });

    const derivedRows = subscriptions
      .filter((subscription) => {
        if (!subscription.user) return false;
        const email = this.normalizeLookup(subscription.user.email);
        return email && !storedEmails.has(email);
      })
      .map((subscription) => ({
        id: `public-client-${subscription.userId}`,
        companyName: subscription.user!.displayName || subscription.user!.name || subscription.user!.email || "Regular client",
        contactPerson: subscription.user!.displayName || subscription.user!.name || null,
        email: subscription.user!.email,
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
        lastServiceDate: subscription.bookings[0]?.slot.date ?? null,
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

  // Safety cap: unbounded findMany on a growing table is a scalability
  // trap. 2000 rows fits the current admin UI comfortably; when we outgrow
  // it, add a `?before=<date>` cursor and stream older rows on demand.
  private static readonly ADMIN_LIST_HARD_CAP = 2000;

  async listCleaningBookings() {
    if (this.shouldUseFallback()) {
      return [];
    }

    return this.prisma.cleaningBooking.findMany({
      orderBy: { slot: { date: "desc" } },
      take: AdminService.ADMIN_LIST_HARD_CAP,
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
      take: AdminService.ADMIN_LIST_HARD_CAP,
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

    const daysOfWeek = input.daysOfWeek;
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
          status: "ACTIVE",
        },
      });

      const dailyTemplate = await tx.cleaningChecklistTemplate.create({
        data: {
          clientId: client.id,
          customPlanId: plan.id,
          templateType: "DAILY_UPKEEP",
          name: "Daily upkeep checklist",
          items: input.dailyChecklist ?? [],
          isActive: true,
        },
      });

      await tx.cleaningChecklistTemplate.create({
        data: {
          clientId: client.id,
          customPlanId: plan.id,
          templateType: "DEEP_CLEANING",
          name: "Deep cleaning checklist",
          items: input.deepCleaningChecklist ?? [],
          isActive: true,
        },
      });

      let bookingsCreated = 0;
      const weekdaySet = new Set<string>(daysOfWeek);

      for (let date = new Date(startDate); date <= endDate; date = this.addDays(date, 1)) {
        if (!weekdaySet.has(this.dayOfWeek(date))) continue;

        const dateStr = this.formatDate(date);
        const slot = await this.findOrCreateCleaningSlot(tx, dateStr, input.preferredStartTime, input.preferredEndTime);
        const bookedCount = await tx.cleaningBooking.count({
          where: {
            slotId: slot.id,
            status: "BOOKED",
          },
        });

        if (bookedCount >= slot.maxBookings) {
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
      const gc = this.cleaningCalendarSync["googleCalendar"];
      const payload = {
        summary:     isCancelled ? `[Cancelled] ${titleBase}` : titleBase,
        location,
        description,
        start,
        end,
        colorId: isCancelled ? "11" : undefined,
        bookingId, // stored in extendedProperties for idempotent lookup
      };

      // Idempotent upsert via extendedProperties search
      let result: { id: string; htmlLink?: string | null };
      let action: string;

      // 0. If the passed event id is already owned by ANOTHER booking (legacy dup
      //    bug), don't touch it — otherwise the two bookings overwrite one event and
      //    "swap". Drop it so we fall through to the bookingId tag / fresh create.
      let storedEventId = data.googleCalendarEventId;
      if (storedEventId) {
        try {
          const others = await this.supabaseRest<Array<{ id: string }>>(
            `/cleaning_bookings?select=id&google_calendar_event_id=eq.${encodeURIComponent(storedEventId)}` +
            `&id=neq.${encodeURIComponent(bookingId)}&status=neq.cancelled&limit=1`,
          );
          if (Array.isArray(others) && others.length > 0) {
            this.logger.warn(`[sync-direct] Event ${storedEventId} shared with another booking; creating fresh for ${bookingId}`);
            storedEventId = undefined;
          }
        } catch {
          storedEventId = undefined; // on lookup error, favour uniqueness
        }
      }

      // 1. Try stored event ID first
      if (storedEventId) {
        try {
          result = isCancelled
            ? await gc.cancelEvent(storedEventId, payload)
            : await gc.updateEvent(storedEventId, payload);
          action = "updated";
        } catch (err) {
          if (!/404|410/.test((err as Error).message ?? "")) throw err;
          // Stored event gone — fall through
          action = "recreate";
          result = { id: "", htmlLink: null };
        }
      } else {
        action = "lookup";
        result = { id: "", htmlLink: null };
      }

      // 2. Search by bookingId if no valid event yet
      if (!result.id) {
        const found = await gc.findEventsByBookingId(bookingId);
        if (found.length > 0) {
          const [keep, ...dupes] = found;
          for (const d of dupes) await gc.deleteEvent(d.id).catch(() => {/* best effort */});
          result = isCancelled
            ? await gc.cancelEvent(keep.id, payload)
            : await gc.updateEvent(keep.id, payload);
          action = "updated_found";
        } else {
          // 3. Create brand new
          if (!isCancelled) {
            result = await gc.createEvent(payload);
            action = "created";
          } else {
            return { ok: true, bookingId, calendarId: this.cleaningCalendarSync.getSharedAdminCalendarId(), skipped: true };
          }
        }
      }

      // Persist event ID back to DB via Supabase REST (no Prisma needed)
      if (result.id) {
        await this.supabaseRest(`/cleaning_bookings?id=eq.${encodeURIComponent(bookingId)}`, {
          method: "PATCH",
          body: JSON.stringify({
            google_calendar_event_id: result.id,
            google_calendar_event_link: result.htmlLink ?? null,
            google_calendar_sync_status: "synced",
            google_calendar_synced_at: new Date().toISOString(),
            google_calendar_sync_error: null,
          }),
        }).catch((e) => this.logger.warn(`Could not persist event ID for booking ${bookingId}: ${(e as Error).message}`));
      }

      this.logger.log(`[sync-direct] Booking ${bookingId} → event ${result.id} (${action})`);
      return {
        ok: true,
        bookingId,
        action,
        calendarId: this.cleaningCalendarSync.getSharedAdminCalendarId(),
        googleCalendarEventId: result.id,
        googleCalendarEventLink: result.htmlLink ?? null,
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : "Google Calendar sync failed";
      return { ok: false, bookingId, error: message };
    }
  }

  /** Reconcile the shared cleaning calendar with the DB (remove orphans, fix dates, sync pending). */
  async reconcileCleaningCalendar() {
    return this.cleaningCalendarSync.reconcileCalendar();
  }

  /** Auto-sync all out-of-date bookings to Google Calendar (cron-driven). */
  async syncPendingCleaningCalendar() {
    return this.cleaningCalendarSync.syncPendingBookings();
  }

  /** Rebuild Google Calendar events for every cleaning booking (REST-only, prod-safe). */
  async restoreCleaningCalendar() {
    return this.cleaningCalendarSync.restoreAllCalendarEvents();
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
            "BOOKED",
            "COMPLETED",
            "CANCELLED",
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

  /**
   * Hard-delete a subscription and ALL associated bookings + Google Calendar events.
   * This is irreversible. Use cancelSubscription for a soft cancel instead.
   */
  async deleteSubscription(subscriptionId: string, actorUserId: string) {
    // 1. Find all bookings for this subscription
    let bookingIds: string[] = [];
    try {
      const [bySubId, byCleaningSubId] = await Promise.all([
        this.supabaseRest<any[]>(
          `/cleaning_bookings?select=id,google_calendar_event_id&subscription_id=eq.${encodeURIComponent(subscriptionId)}`,
        ).catch(() => [] as any[]),
        this.supabaseRest<any[]>(
          `/cleaning_bookings?select=id,google_calendar_event_id&cleaning_subscription_id=eq.${encodeURIComponent(subscriptionId)}`,
        ).catch(() => [] as any[]),
      ]);
      const seen = new Set<string>();
      for (const b of [...bySubId, ...byCleaningSubId]) {
        if (!seen.has(b.id)) { seen.add(b.id); bookingIds.push(b.id); }
      }
    } catch (err) {
      this.logger.warn(`deleteSubscription: could not load bookings: ${(err as Error).message}`);
    }

    // 2. Remove Google Calendar events for each booking
    if (this.cleaningCalendarSync.isConfigured() && bookingIds.length) {
      for (const bookingId of bookingIds) {
        await this.cleaningCalendarSync.deleteCalendarEventForBooking(bookingId)
          .catch((e) => this.logger.warn(`deleteSubscription: calendar delete for booking ${bookingId}: ${(e as Error).message}`));
      }
    }

    // 3. Decrement slot counts BEFORE deleting bookings
    if (bookingIds.length) {
      const slotIds = (await this.supabaseRest<any[]>(
        `/cleaning_bookings?select=slot_id&id=in.(${bookingIds.join(",")})`,
      ).catch(() => [])).map((b) => b.slot_id).filter(Boolean);
      await this.decrementSlotBookings(slotIds);
    }

    // 4. Delete all bookings
    if (bookingIds.length) {
      await Promise.all([
        this.supabaseRest(
          `/cleaning_bookings?subscription_id=eq.${encodeURIComponent(subscriptionId)}`,
          { method: "DELETE" },
        ).catch((e) => this.logger.warn(`deleteSubscription: DELETE by subscription_id: ${(e as Error).message}`)),
        this.supabaseRest(
          `/cleaning_bookings?cleaning_subscription_id=eq.${encodeURIComponent(subscriptionId)}`,
          { method: "DELETE" },
        ).catch((e) => this.logger.warn(`deleteSubscription: DELETE by cleaning_subscription_id: ${(e as Error).message}`)),
      ]);
    }

    // 5. Delete the subscription itself
    await this.supabaseRest(
      `/cleaning_subscriptions?id=eq.${encodeURIComponent(subscriptionId)}`,
      { method: "DELETE" },
    );

    await this.auditAdminEvent(actorUserId, "delete", "subscription", subscriptionId, {
      bookings_deleted: bookingIds.length,
    });

    this.logger.log(`[delete] Subscription ${subscriptionId} hard-deleted (${bookingIds.length} bookings removed)`);
    return { deleted: true, bookings_deleted: bookingIds.length };
  }

  async deleteCleaningBooking(id: string) {
    if (this.shouldUseFallback()) {
      return { deleted: true };
    }

    // Look up the slot before deleting so we can free its capacity.
    // Only bookings still counting toward the slot (not already cancelled)
    // should decrement current_bookings — a cancelled booking already did.
    const booking = await this.prisma.cleaningBooking.findUnique({
      where: { id },
      select: { slotId: true, status: true },
    });

    await this.cleaningCalendarSync.deleteCalendarEventForBooking(id);
    await this.prisma.cleaningBooking.delete({ where: { id } });

    if (booking?.slotId && booking.status !== "cancelled") {
      await this.decrementSlotBookings([booking.slotId]);
    }
    return { deleted: true };
  }

  /**
   * Decrement current_bookings on slots for each cancelled/deleted booking.
   * Groups by slotId so a single batch of cancellations makes one PATCH per slot.
   */
  private async decrementSlotBookings(slotIds: string[]) {
    if (!slotIds.length) return;
    // Count how many bookings per slot are being freed
    const countBySlot = new Map<string, number>();
    for (const id of slotIds) countBySlot.set(id, (countBySlot.get(id) ?? 0) + 1);

    await Promise.all(
      [...countBySlot.entries()].map(async ([slotId, count]) => {
        try {
          // Fetch current count, then decrement (floor at 0)
          const rows = await this.supabaseRest<any[]>(
            `/cleaning_available_slots?select=current_bookings&id=eq.${encodeURIComponent(slotId)}&limit=1`,
          );
          const current = Number(rows?.[0]?.current_bookings ?? 0);
          const newCount = Math.max(0, current - count);
          await this.supabaseRest(`/cleaning_available_slots?id=eq.${encodeURIComponent(slotId)}`, {
            method: "PATCH",
            body: JSON.stringify({ current_bookings: newCount, updated_at: new Date().toISOString() }),
          });
          this.logger.log(`[slots] Slot ${slotId}: current_bookings ${current} → ${newCount}`);
        } catch (e) {
          this.logger.warn(`decrementSlotBookings slot ${slotId}: ${(e as Error).message}`);
        }
      }),
    );
  }

  private pickSubscriptionFields(input: Record<string, unknown>) {
    const picked: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(input)) {
      if (!SUBSCRIPTION_WRITE_COLUMNS.has(key) || value === undefined) continue;
      picked[key] = value;
    }
    return picked;
  }

  private async auditAdminEvent(
    actorUserId: string,
    action: string,
    entityType: string,
    entityId: string | null,
    details: unknown = {},
  ) {
    if (this.shouldUseFallback()) {
      await this.supabaseRest("/admin_audit_logs", {
        method: "POST",
        body: JSON.stringify({
          admin_user_id: actorUserId,
          action,
          entity_type: entityType,
          entity_id: entityId,
          details: details ?? {},
        }),
      }).catch(() => undefined);
      return;
    }
    await this.prisma.$executeRawUnsafe(
      `INSERT INTO public.admin_audit_logs (admin_user_id, action, entity_type, entity_id, details)
       SELECT $1, $2, $3, $4, $5::jsonb
       WHERE to_regclass('public.admin_audit_logs') IS NOT NULL`,
      actorUserId,
      action,
      entityType,
      entityId,
      JSON.stringify(details ?? {}),
    ).catch(() => undefined);
  }

  private async supabaseRest<T = unknown>(path: string, init: RequestInit = {}): Promise<T> {
    const baseUrl = process.env.SUPABASE_URL?.replace(/\/$/, "");
    const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
    const anonKey = process.env.SUPABASE_ANON_KEY;
    const apiKey = serviceKey || anonKey;
    if (!baseUrl || !apiKey) throw new Error("Supabase REST is not configured.");
    const response = await fetch(`${baseUrl}/rest/v1${path}`, {
      ...init,
      headers: {
        apikey: apiKey,
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
        ...(init.method && init.method !== "GET" ? { Prefer: "return=representation" } : {}),
        ...(init.headers || {}),
      },
    });
    if (!response.ok) {
      const body = await response.text().catch(() => response.statusText);
      throw new Error(`Supabase REST ${response.status}: ${body}`);
    }
    if (response.status === 204) return undefined as T;
    return response.json() as Promise<T>;
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
    return status.toUpperCase();
  }

  private toBillingType(type: string) {
    return type.toUpperCase();
  }

  private toPaymentTiming(type: string) {
    return type.toUpperCase();
  }

  private toScheduleStatus(status: string) {
    return status.toUpperCase();
  }

  private toBookingStatus(status: string) {
    return status.toUpperCase();
  }

  private async syncBookingsToCalendar(bookingIds: string[]): Promise<Array<{ ok: boolean; bookingId: string; error?: string }>> {
    const results: Array<{ ok: boolean; bookingId: string; error?: string }> = [];
    for (const bookingId of bookingIds) {
      try {
        const r = await this.cleaningCalendarSync.syncBookingById(bookingId);
        results.push({ ok: r.ok, bookingId, error: r.ok ? undefined : String((r as any).error ?? "") });
      } catch (err) {
        // Never let a calendar sync failure crash the subscription/booking creation
        this.logger.warn(`Calendar sync failed for booking ${bookingId}: ${(err as Error).message}`);
        results.push({ ok: false, bookingId, error: (err as Error).message });
      }
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
    status: string,
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

  private dayOfWeek(date: Date): string {
    const days = ["SUNDAY", "MONDAY", "TUESDAY", "WEDNESDAY", "THURSDAY", "FRIDAY", "SATURDAY"];
    return days[date.getUTCDay()];
  }

  private formatDate(date: Date) {
    return date.toISOString().slice(0, 10);
  }

  private async findOrCreateCleaningSlot(
    tx: Prisma.TransactionClient,
    date: string,
    startTime: string,
    endTime: string,
  ) {
    const normalizedStart = startTime.length === 5 ? `${startTime}:00` : startTime;
    const normalizedEnd = endTime.length === 5 ? `${endTime}:00` : endTime;

    const existing = await tx.cleaningAvailableSlot.findFirst({
      where: {
        date,
        startTime: normalizedStart,
        endTime: normalizedEnd,
        isActive: true,
      },
    });

    if (existing) {
      return existing;
    }

    // Read capacity from settings
    const settings = await tx.globalSetting.findMany({
      where: { key: { in: ["default_slot_capacity", "saturday_slot_capacity"] } },
    });
    const settingsMap = new Map(settings.map((s) => [s.key, s.value]));
    const defaultCap = Math.max(1, Number(settingsMap.get("default_slot_capacity")) || 1);
    const saturdayCap = Math.max(1, Number(settingsMap.get("saturday_slot_capacity")) || defaultCap);
    const d = new Date(`${date}T00:00:00`);
    const capacity = d.getDay() === 6 ? saturdayCap : defaultCap;

    return tx.cleaningAvailableSlot.create({
      data: {
        date,
        startTime: normalizedStart,
        endTime: normalizedEnd,
        maxBookings: capacity,
        currentBookings: 0,
        isActive: true,
      },
    });
  }
}
