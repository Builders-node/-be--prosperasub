import { Injectable, Logger } from "@nestjs/common";
import { PrismaService } from "../prisma/prisma.service";

export type NotificationCategory = "payment" | "subscription" | "booking" | "reminder" | "plan";
export type NotificationType =
  | "payment_received"
  | "payment_pending"
  | "payment_failed"
  | "subscription_created"
  | "subscription_expiring_soon"
  | "subscription_expiring_tomorrow"
  | "subscription_expired"
  | "plan_created"
  | "plan_updated"
  | "plan_cancelled"
  | "booking_created"
  | "booking_updated"
  | "booking_cancelled"
  | "booking_completed"
  | "calendar_updated"
  | "reminder_general";

export interface CreateUserNotificationInput {
  recipientUserId: string;
  category: NotificationCategory;
  type: NotificationType;
  title: string;
  body: string;
  relatedEntityType?: string;
  relatedEntityId?: string;
  actionUrl?: string;
  metadata?: Record<string, unknown>;
}

@Injectable()
export class AccountNotificationsService {
  private readonly logger = new Logger(AccountNotificationsService.name);

  constructor(private readonly prisma: PrismaService) {}

  // ─── Internal helpers ──────────────────────────────────────────────────────

  private get dbAvailable() {
    return this.prisma.isAvailable();
  }

  private supabaseRest<T = unknown>(path: string, init: RequestInit = {}): Promise<T> {
    const baseUrl = process.env.SUPABASE_URL?.replace(/\/$/, "");
    const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
    const anonKey = process.env.SUPABASE_ANON_KEY;
    const apiKey = serviceKey || anonKey;
    if (!baseUrl || !apiKey) throw new Error("Supabase REST not configured");
    return fetch(`${baseUrl}/rest/v1${path}`, {
      ...init,
      headers: {
        apikey: apiKey,
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
        Prefer: "return=representation",
        ...(init.headers || {}),
      },
    }).then(async (res) => {
      const body = await res.json().catch(() => null);
      if (!res.ok) throw new Error(body?.message || `Supabase REST error ${res.status}`);
      return body as T;
    });
  }

  // ─── Public API ────────────────────────────────────────────────────────────

  /** Create a notification for a user. Used by other services (payments, admin actions, etc.) */
  async create(input: CreateUserNotificationInput) {
    if (!this.dbAvailable) {
      // Fallback: write directly via Supabase REST
      try {
        await this.supabaseRest("/user_notifications", {
          method: "POST",
          body: JSON.stringify({
            recipient_user_id: input.recipientUserId,
            category: input.category,
            type: input.type,
            title: input.title,
            body: input.body,
            related_entity_type: input.relatedEntityType ?? null,
            related_entity_id: input.relatedEntityId ?? null,
            action_url: input.actionUrl ?? null,
            metadata: input.metadata ?? null,
          }),
        });
      } catch (err) {
        this.logger.warn(`[notifications] DB & REST unavailable — notification for ${input.recipientUserId} not persisted: ${(err as Error).message}`);
      }
      return null;
    }

    try {
      return await this.prisma.userNotification.create({
        data: {
          recipientUserId: input.recipientUserId,
          category: input.category,
          type: input.type,
          title: input.title,
          body: input.body,
          relatedEntityType: input.relatedEntityType ?? null,
          relatedEntityId: input.relatedEntityId ?? null,
          actionUrl: input.actionUrl ?? null,
          metadata: input.metadata ? JSON.parse(JSON.stringify(input.metadata)) : undefined,
        },
      });
    } catch (err) {
      this.logger.error(`Failed to create notification for user ${input.recipientUserId}: ${(err as Error).message}`);
      return null;
    }
  }

  /** GET /account/notifications */
  async getNotifications(
    userId: string,
    opts: { category?: string; unreadOnly?: boolean } = {},
  ) {
    if (!this.dbAvailable) {
      try {
        const filters = [
          `recipient_user_id=eq.${encodeURIComponent(userId)}`,
          "is_archived=eq.false",
          opts.unreadOnly ? "is_read=eq.false" : null,
          opts.category && opts.category !== "all" ? `category=eq.${encodeURIComponent(opts.category)}` : null,
        ].filter(Boolean).join("&");
        return await this.supabaseRest<any[]>(`/user_notifications?${filters}&order=created_at.desc&limit=100`);
      } catch (err) {
        this.logger.warn(`[notifications] REST fallback failed for getNotifications: ${(err as Error).message}`);
        return [];
      }
    }

    const where: Record<string, unknown> = { recipientUserId: userId, isArchived: false };
    if (opts.category && opts.category !== "all") where.category = opts.category;
    if (opts.unreadOnly) where.isRead = false;

    return this.prisma.userNotification.findMany({
      where,
      orderBy: { createdAt: "desc" },
      take: 100,
    });
  }

  /** GET /account/notifications/unread-count */
  async getUnreadCount(userId: string): Promise<{ count: number }> {
    if (!this.dbAvailable) {
      try {
        const rows = await this.supabaseRest<any[]>(
          `/user_notifications?select=id&recipient_user_id=eq.${encodeURIComponent(userId)}&is_read=eq.false&is_archived=eq.false`,
        );
        return { count: Array.isArray(rows) ? rows.length : 0 };
      } catch {
        return { count: 0 };
      }
    }

    try {
      const count = await this.prisma.userNotification.count({
        where: { recipientUserId: userId, isRead: false, isArchived: false },
      });
      return { count };
    } catch (err) {
      this.logger.warn(`getUnreadCount failed: ${(err as Error).message}`);
      return { count: 0 };
    }
  }

  /** PATCH /account/notifications/:id/read */
  async markAsRead(userId: string, notificationId: string) {
    if (!this.dbAvailable) {
      try {
        await this.supabaseRest(
          `/user_notifications?id=eq.${encodeURIComponent(notificationId)}&recipient_user_id=eq.${encodeURIComponent(userId)}`,
          { method: "PATCH", body: JSON.stringify({ is_read: true, updated_at: new Date().toISOString() }) },
        );
      } catch { /* best effort */ }
      return { ok: true };
    }
    try {
      await this.prisma.userNotification.updateMany({
        where: { id: notificationId, recipientUserId: userId },
        data: { isRead: true, updatedAt: new Date() },
      });
    } catch (err) {
      this.logger.warn(`markAsRead failed: ${(err as Error).message}`);
    }
    return { ok: true };
  }

  /** PATCH /account/notifications/mark-all-read */
  async markAllRead(userId: string) {
    if (!this.dbAvailable) {
      try {
        await this.supabaseRest(
          `/user_notifications?recipient_user_id=eq.${encodeURIComponent(userId)}&is_read=eq.false&is_archived=eq.false`,
          { method: "PATCH", body: JSON.stringify({ is_read: true, updated_at: new Date().toISOString() }) },
        );
      } catch { /* best effort */ }
      return { ok: true, updated: 0 };
    }
    try {
      const result = await this.prisma.userNotification.updateMany({
        where: { recipientUserId: userId, isRead: false, isArchived: false },
        data: { isRead: true, updatedAt: new Date() },
      });
      return { ok: true, updated: result.count };
    } catch (err) {
      this.logger.warn(`markAllRead failed: ${(err as Error).message}`);
      return { ok: true, updated: 0 };
    }
  }

  /** PATCH /account/notifications/:id/archive */
  async archive(userId: string, notificationId: string) {
    if (!this.dbAvailable) {
      try {
        await this.supabaseRest(
          `/user_notifications?id=eq.${encodeURIComponent(notificationId)}&recipient_user_id=eq.${encodeURIComponent(userId)}`,
          { method: "PATCH", body: JSON.stringify({ is_archived: true, updated_at: new Date().toISOString() }) },
        );
      } catch { /* best effort */ }
      return { ok: true };
    }
    try {
      await this.prisma.userNotification.updateMany({
        where: { id: notificationId, recipientUserId: userId },
        data: { isArchived: true, updatedAt: new Date() },
      });
    } catch (err) {
      this.logger.warn(`archive failed: ${(err as Error).message}`);
    }
    return { ok: true };
  }
}
