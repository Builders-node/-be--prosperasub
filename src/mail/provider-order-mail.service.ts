import { Injectable, Logger } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { MailService } from "./mail.service";

/**
 * "You have a new order" — to the business that has to fulfil it.
 *
 * Until this existed the platform told the CUSTOMER their payment went
 * through and told the provider nothing at all: a restaurant learned about a
 * meal plan by opening the admin panel, and a cleaner learned about a booking
 * when somebody rang. Every order writer is a different surface (three
 * checkouts in the browser, the rentals API, the reconcile cron), so the
 * notification has to be idempotent rather than owned by one of them:
 *
 *   claim the slot in `provider_order_notifications` → send → record who got it
 *
 * The claim is an insert that ignores duplicates, so a checkout firing this
 * from the browser and the reconcile cron firing it again when the payment
 * lands twenty minutes later produce ONE email, not two.
 *
 * Recipients are the owner (`providers.admin_user_id`) and everyone on the
 * team (`provider_members`) — the same people the workspace lets in. Money and
 * dates are read from the order row with the service key, never taken from
 * the caller: a browser that can ask for an email must not be able to dictate
 * what the email says a customer paid.
 */

/** The tables an order can live in, and how to read one. */
const ORDER_SOURCES: Record<string, {
  select: string;
  provider: (row: any) => string | null;
  /** Legacy tables key their provider by the LEGACY id — bridge it. */
  legacyKey?: string;
  title: (row: any) => string;
  totalCents: (row: any) => number;
  starts: (row: any) => string | null;
  ends: (row: any) => string | null;
  customer: (row: any) => string | null;
}> = {
  provider_subscriptions: {
    select: "id,provider_id,plan_id,user_id,price_cents,start_date,end_date,metadata,payment_method,payment_status",
    provider: (r) => r.provider_id ?? null,
    title: (r) => r.metadata?.plan_name || "Subscription",
    totalCents: (r) => Number(r.price_cents) || 0,
    starts: (r) => r.start_date ?? null,
    ends: (r) => r.end_date ?? null,
    customer: (r) => r.metadata?.customer_name || r.metadata?.customer_email || null,
  },
  food_subscriptions: {
    select: "id,provider_id,meal_plan_id,customer_name,weekly_price_cents,commitment_weeks,started_at,end_date,payment_method,payment_status",
    provider: (r) => r.provider_id ?? null,
    legacyKey: "food",
    title: () => "Meal plan",
    totalCents: (r) => (Number(r.weekly_price_cents) || 0) * Math.max(Number(r.commitment_weeks) || 1, 1),
    starts: (r) => r.started_at ?? null,
    ends: (r) => r.end_date ?? null,
    customer: (r) => r.customer_name ?? null,
  },
  cleaning_subscriptions: {
    select: "id,provider_id,package_id,user_id,total_price_cents,monthly_price_cents,service_start_date,service_end_date,payment_method,payment_status",
    provider: (r) => r.provider_id ?? null,
    legacyKey: "cleaning",
    title: () => "Cleaning plan",
    totalCents: (r) => Number(r.total_price_cents) || Number(r.monthly_price_cents) || 0,
    starts: (r) => r.service_start_date ?? null,
    ends: (r) => r.service_end_date ?? null,
    customer: () => null,
  },
  rental_bookings: {
    select: "id,provider_id,vehicle_id,user_id,customer_name,total_cents,start_date,end_date,payment_method,payment_status",
    provider: (r) => r.provider_id ?? null,
    title: () => "Vehicle booking",
    totalCents: (r) => Number(r.total_cents) || 0,
    starts: (r) => r.start_date ?? null,
    ends: (r) => r.end_date ?? null,
    customer: (r) => r.customer_name ?? null,
  },
};

export type OrderTable = keyof typeof ORDER_SOURCES;

export const isOrderTable = (value: string): value is OrderTable =>
  Object.prototype.hasOwnProperty.call(ORDER_SOURCES, value);

@Injectable()
export class ProviderOrderMailService {
  private readonly logger = new Logger(ProviderOrderMailService.name);

  constructor(
    private readonly mail: MailService,
    private readonly config: ConfigService,
  ) {}

  /**
   * Tell a business about one order. Safe to call from anywhere, any number
   * of times: the first call that claims the ledger row sends the email and
   * every later one returns `{ sent: false, reason: "already-sent" }`.
   */
  async notifyNewOrder(table: string, orderId: string): Promise<{ sent: boolean; reason?: string; recipients?: string[] }> {
    if (!isOrderTable(table)) return { sent: false, reason: "unknown-table" };
    const source = ORDER_SOURCES[table];

    const [order] = await this.rest<any[]>(
      `/${table}?id=eq.${encodeURIComponent(orderId)}&select=${source.select}&limit=1`,
    ) ?? [];
    if (!order) return { sent: false, reason: "no-order" };

    const providerId = await this.resolveProvider(source, order);
    if (!providerId) return { sent: false, reason: "no-provider" };

    const recipients = await this.recipients(providerId);
    if (recipients.length === 0) return { sent: false, reason: "no-recipients" };

    // Claim first. A send that fails leaves the slot claimed on purpose: an
    // unsent email is better than the same one four times when the provider
    // reloads their workspace.
    const claimed = await this.claim(table, orderId, providerId, recipients);
    if (!claimed) return { sent: false, reason: "already-sent" };

    const [provider] = await this.rest<any[]>(
      `/providers?id=eq.${encodeURIComponent(providerId)}&select=name&limit=1`,
    ) ?? [];

    const subject = `New order · ${source.title(order)}`;
    const lines = [
      `${provider?.name ?? "Your business"} has a new order.`,
      "",
      `What: ${source.title(order)}`,
      source.customer(order) ? `Customer: ${source.customer(order)}` : null,
      `Total: ${this.usd(source.totalCents(order))}`,
      source.starts(order) ? `Starts: ${source.starts(order)}` : null,
      source.ends(order) ? `Ends: ${source.ends(order)}` : null,
      `Payment: ${order.payment_status ?? "pending"}${order.payment_method ? ` · ${order.payment_method}` : ""}`,
      "",
      `Open it here: ${this.appUrl()}/my-provider/${providerId}`,
    ].filter(Boolean) as string[];

    const html = `
      <h1>New order</h1>
      <p>${this.esc(provider?.name ?? "Your business")} has a new order.</p>
      <table cellpadding="8" cellspacing="0" style="border-collapse:collapse">
        <tr><td><strong>What</strong></td><td>${this.esc(source.title(order))}</td></tr>
        ${source.customer(order) ? `<tr><td><strong>Customer</strong></td><td>${this.esc(String(source.customer(order)))}</td></tr>` : ""}
        <tr><td><strong>Total</strong></td><td>${this.usd(source.totalCents(order))}</td></tr>
        ${source.starts(order) ? `<tr><td><strong>Starts</strong></td><td>${this.esc(String(source.starts(order)))}</td></tr>` : ""}
        ${source.ends(order) ? `<tr><td><strong>Ends</strong></td><td>${this.esc(String(source.ends(order)))}</td></tr>` : ""}
        <tr><td><strong>Payment</strong></td><td>${this.esc(String(order.payment_status ?? "pending"))}</td></tr>
      </table>
      <p><a href="${this.esc(this.appUrl())}/my-provider/${this.esc(providerId)}">Open your workspace</a></p>`;

    // One message per recipient rather than a shared To: the owner and each
    // manager get their own copy, and nobody learns the others' addresses.
    await Promise.all(recipients.map((to) =>
      this.mail.sendMail({ to, subject, text: lines.join("\n"), html })
        .catch((err) => this.logger.warn(`order mail to ${to} failed: ${(err as Error).message}`)),
    ));

    return { sent: true, recipients };
  }

  /** The universal provider id, bridging a legacy row's own provider id. */
  private async resolveProvider(source: (typeof ORDER_SOURCES)[OrderTable], order: any): Promise<string | null> {
    const raw = source.provider(order);
    if (!raw) return null;
    if (!source.legacyKey) return raw;
    // Legacy tables carry the per-service id; the universal row points back at
    // it (see lib/services/providerBridge on the front end).
    const [row] = await this.rest<any[]>(
      `/providers?source_service_key=eq.${source.legacyKey}&source_provider_id=eq.${encodeURIComponent(raw)}&select=id&limit=1`,
    ) ?? [];
    return row?.id ?? null;
  }

  /** Owner + team, deduped, lower-cased. */
  private async recipients(providerId: string): Promise<string[]> {
    const out = new Set<string>();

    const [provider] = await this.rest<any[]>(
      `/providers?id=eq.${encodeURIComponent(providerId)}&select=admin_user_id,contact_email&limit=1`,
    ) ?? [];

    if (provider?.admin_user_id) {
      const [owner] = await this.rest<any[]>(
        `/users?id=eq.${encodeURIComponent(provider.admin_user_id)}&select=email&limit=1`,
      ) ?? [];
      if (owner?.email) out.add(String(owner.email).trim().toLowerCase());
    }

    // The address the business publishes. A platform-owned business (the beach
    // club) has no owner account at all, and would otherwise be told nothing.
    if (provider?.contact_email) out.add(String(provider.contact_email).trim().toLowerCase());

    const members = await this.rest<any[]>(
      `/provider_members?provider_id=eq.${encodeURIComponent(providerId)}&select=user_id,user_email`,
    ) ?? [];
    const missing: string[] = [];
    for (const m of members) {
      if (m.user_email) out.add(String(m.user_email).trim().toLowerCase());
      else if (m.user_id) missing.push(String(m.user_id));
    }
    if (missing.length) {
      const rows = await this.rest<any[]>(
        `/users?id=in.(${missing.map((id) => encodeURIComponent(id)).join(",")})&select=email`,
      ) ?? [];
      rows.forEach((r) => r?.email && out.add(String(r.email).trim().toLowerCase()));
    }

    return [...out].filter((e) => e.includes("@"));
  }

  /** True when THIS call claimed the slot — see the class comment. */
  private async claim(table: string, orderId: string, providerId: string, recipients: string[]): Promise<boolean> {
    try {
      const rows = await this.rest<any[]>(
        `/provider_order_notifications?on_conflict=order_table,order_id,kind`,
        {
          method: "POST",
          headers: { Prefer: "resolution=ignore-duplicates,return=representation" },
          body: JSON.stringify({
            order_table: table,
            order_id: orderId,
            kind: "new_order",
            provider_id: providerId,
            recipients,
          }),
        },
      );
      return Array.isArray(rows) && rows.length > 0;
    } catch (err) {
      this.logger.warn(`claim failed for ${table}:${orderId}: ${(err as Error).message}`);
      return false;
    }
  }

  // ─── plumbing ───────────────────────────────────────────────────────────────

  private appUrl(): string {
    return (this.config.get<string>("APP_URL") || "https://everysub.net").replace(/\/+$/, "");
  }

  private usd(cents: number): string {
    return `$${((Number(cents) || 0) / 100).toFixed(2)}`;
  }

  private esc(value: string): string {
    return String(value).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
  }

  private async rest<T>(path: string, init: RequestInit = {}): Promise<T | null> {
    const url = this.config.get<string>("SUPABASE_URL");
    const key = this.config.get<string>("SUPABASE_SERVICE_ROLE_KEY");
    if (!url || !key) {
      this.logger.warn("Supabase service credentials are missing; provider order mail is disabled.");
      return null;
    }
    const res = await fetch(`${url.replace(/\/+$/, "")}/rest/v1${path}`, {
      ...init,
      headers: {
        apikey: key,
        Authorization: `Bearer ${key}`,
        "Content-Type": "application/json",
        ...(init.headers as Record<string, string> | undefined),
      },
    });
    if (!res.ok) throw new Error(`${res.status} ${await res.text()}`);
    const text = await res.text();
    return text ? (JSON.parse(text) as T) : null;
  }
}
