import { BadRequestException, Injectable, Logger, NotFoundException, Optional } from "@nestjs/common";
import { BlinkService } from "../payments/blink.service";
import { PrismaService } from "../prisma/prisma.service";

@Injectable()
export class AccountPaymentService {
  private readonly logger = new Logger(AccountPaymentService.name);

  constructor(
    @Optional() private readonly blink?: BlinkService,
    @Optional() private readonly prisma?: PrismaService,
  ) {}

  private supabaseRest<T = unknown>(path: string, init: RequestInit = {}): Promise<T> {
    const base = process.env.SUPABASE_URL?.replace(/\/$/, "");
    const key  = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_ANON_KEY;
    if (!base || !key) throw new Error("Supabase REST not configured");
    return fetch(`${base}/rest/v1${path}`, {
      ...init,
      headers: { apikey: key, Authorization: `Bearer ${key}`, "Content-Type": "application/json", Prefer: "return=representation", ...(init.headers || {}) },
    }).then(async (res) => {
      const body = await res.json().catch(() => null);
      if (!res.ok) throw new Error(body?.message || `Supabase ${res.status}`);
      return body as T;
    });
  }

  /** Check if user has any admin RBAC role. */
  async checkAdminRole(userId: string): Promise<{ isAdmin: boolean }> {
    if (this.prisma) {
      if (!this.prisma.isAvailable()) {
        try { await this.prisma.$connect(); } catch { /* continue */ }
      }
      try {
        const rows = await this.prisma.$queryRawUnsafe<Array<{ found: boolean }>>(
          `SELECT EXISTS (
            SELECT 1 FROM public.rbac_user_roles ur
            JOIN public.rbac_roles r ON r.id = ur.role_id
            WHERE ur.user_id = $1 AND ur.removed_at IS NULL AND r.is_admin_role = true AND r.status = 'active'
          ) AS found`,
          userId,
        );
        return { isAdmin: Boolean(rows[0]?.found) };
      } catch { /* fall through */ }
    }
    return { isAdmin: false };
  }

  /** Fetch subscription if it belongs to this user (direct or via linked client). */
  async getSubscriptionForUser(userId: string, subscriptionId: string): Promise<Record<string, any> | null> {
    try {
      const rows = await this.supabaseRest<any[]>(
        `/cleaning_subscriptions?select=id,user_id,client_id,payment_status,subscription_status,total_price_cents,monthly_price_cents,package_id,payment_reference&id=eq.${encodeURIComponent(subscriptionId)}&limit=1`,
      );
      const sub = rows?.[0];
      if (!sub) return null;
      if (sub.user_id === userId) return sub;
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

  async createInvoice(userId: string, subscriptionId: string) {
    const sub = await this.getSubscriptionForUser(userId, subscriptionId);
    if (!sub) throw new NotFoundException("Subscription not found or not accessible");
    if (sub.payment_status === "paid") {
      return { status: "paid", message: "This subscription has already been paid." };
    }
    if (!this.blink) {
      throw new BadRequestException("Payment provider is not configured. Please contact support.");
    }

    const amountCents = Number(sub.total_price_cents) || Number(sub.monthly_price_cents) || 0;
    if (amountCents <= 0) throw new BadRequestException("Subscription has no amount to charge.");

    // Resolve plan name
    let planName = "Cleaning subscription";
    try {
      const pkgs = await this.supabaseRest<any[]>(`/cleaning_packages?select=name&id=eq.${encodeURIComponent(sub.package_id)}&limit=1`);
      planName = pkgs?.[0]?.name ?? planName;
    } catch { /* use default */ }

    // If existing invoice, check its status
    if (sub.payment_reference) {
      try {
        const status = await this.blink.getPaymentStatus(sub.payment_reference);
        if (status.paid) {
          await this.supabaseRest(`/cleaning_subscriptions?id=eq.${encodeURIComponent(subscriptionId)}`, {
            method: "PATCH",
            body: JSON.stringify({ payment_status: "paid", subscription_status: "active", is_active: true, updated_at: new Date().toISOString() }),
          });
          return { status: "paid", message: "Payment confirmed!" };
        }
        if (status.payment_request) {
          return { subscription_id: subscriptionId, payment_hash: sub.payment_reference, payment_request: status.payment_request, amount_cents: amountCents, plan_name: planName, status: "pending" };
        }
      } catch { /* create new */ }
    }

    // Create new invoice
    const invoice = await this.blink.createUsdInvoice({
      amountCents,
      memo: planName,
      externalId: `sub-${subscriptionId}-${Date.now()}`,
    });

    await this.supabaseRest(`/cleaning_subscriptions?id=eq.${encodeURIComponent(subscriptionId)}`, {
      method: "PATCH",
      body: JSON.stringify({ payment_reference: invoice.payment_hash, payment_method: "lightning", updated_at: new Date().toISOString() }),
    });

    this.logger.log(`[payment] Invoice created for subscription ${subscriptionId}`);
    return { subscription_id: subscriptionId, payment_hash: invoice.payment_hash, payment_request: invoice.payment_request, amount_cents: amountCents, amount_sats: invoice.amount_sats, plan_name: planName, status: "pending" };
  }
}
