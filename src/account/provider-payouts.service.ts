import { BadRequestException, ForbiddenException, Injectable, Logger, NotFoundException } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";

/**
 * The payout ledger.
 *
 * `provider_payouts` is the one table on this platform with RLS on and no
 * policies — the browser cannot see or touch it with the anon key. Everything
 * about it therefore goes through here, with the service role.
 *
 * Two audiences, one table:
 *   • the owner of a provider reads their own rows;
 *   • an admin reads any and writes them.
 *
 * Ownership is `providers.admin_user_id`, deliberately not the per-service
 * manager tables. A manager runs the business day to day; what the business
 * has been paid is the owner's.
 */

export interface PayoutRow {
  id: string;
  provider_id: string;
  amount_cents: number;
  currency: string;
  period_start: string | null;
  period_end: string | null;
  method: string | null;
  reference: string | null;
  note: string | null;
  paid_at: string;
  created_by: string | null;
  created_at: string;
}

export interface CreatePayoutInput {
  providerId: string;
  amountCents: number;
  periodStart?: string | null;
  periodEnd?: string | null;
  method?: string | null;
  reference?: string | null;
  note?: string | null;
  paidAt?: string | null;
}

@Injectable()
export class ProviderPayoutsService {
  private readonly logger = new Logger(ProviderPayoutsService.name);

  constructor(private readonly config: ConfigService) {}

  /** Payouts for one provider, newest first. Throws unless the caller owns it. */
  async listForOwner(userId: string, providerId: string, isAdmin = false): Promise<PayoutRow[]> {
    await this.assertOwner(userId, providerId, isAdmin);
    return this.list(providerId);
  }

  async list(providerId: string): Promise<PayoutRow[]> {
    const rows = await this.rest<PayoutRow[]>(
      `provider_payouts?provider_id=eq.${encodeURIComponent(providerId)}` +
        `&select=*&order=paid_at.desc`,
    );
    return rows ?? [];
  }

  async create(input: CreatePayoutInput, createdBy: string | null): Promise<PayoutRow> {
    const amount = Math.round(Number(input.amountCents));
    if (!Number.isFinite(amount) || amount <= 0) {
      throw new BadRequestException("A payout amount must be a positive number of cents.");
    }
    if (input.periodStart && input.periodEnd && input.periodEnd < input.periodStart) {
      throw new BadRequestException("The period ends before it starts.");
    }

    const created = await this.post<PayoutRow[]>("provider_payouts", {
      provider_id: input.providerId,
      amount_cents: amount,
      period_start: input.periodStart || null,
      period_end: input.periodEnd || null,
      method: input.method || null,
      reference: input.reference || null,
      note: input.note || null,
      paid_at: input.paidAt || new Date().toISOString(),
      created_by: createdBy,
    });
    const row = created?.[0];
    if (!row) throw new BadRequestException("The payout could not be recorded.");
    this.logger.log(`[payout] +${amount} to provider ${input.providerId} by ${createdBy ?? "unknown"}`);
    return row;
  }

  async remove(id: string): Promise<{ ok: true }> {
    await this.del(`provider_payouts?id=eq.${encodeURIComponent(id)}`);
    this.logger.log(`[payout] removed ${id}`);
    return { ok: true };
  }

  private async assertOwner(userId: string, providerId: string, isAdmin: boolean): Promise<void> {
    if (isAdmin) return;
    const rows = await this.rest<Array<{ admin_user_id: string | null }>>(
      `providers?id=eq.${encodeURIComponent(providerId)}&select=admin_user_id&limit=1`,
    );
    const row = rows?.[0];
    if (!row) throw new NotFoundException("Provider not found.");
    if (!row.admin_user_id || String(row.admin_user_id) !== String(userId)) {
      throw new ForbiddenException("You don't own this business.");
    }
  }

  // ─── Supabase REST (service role — this table is invisible to the anon key) ──

  private restBase(): { base: string; key: string } {
    const base = this.config.get<string>("SUPABASE_URL")?.replace(/\/$/, "");
    const key = this.config.get<string>("SUPABASE_SERVICE_ROLE_KEY");
    if (!base || !key) {
      // The anon key would silently return an empty list here rather than fail,
      // which reads as "no payouts" — say it out loud instead.
      throw new Error("provider_payouts needs SUPABASE_SERVICE_ROLE_KEY; the anon key cannot see this table.");
    }
    return { base, key };
  }

  private headers(extra: Record<string, string> = {}) {
    const { key } = this.restBase();
    return { apikey: key, Authorization: `Bearer ${key}`, ...extra };
  }

  private async rest<T>(path: string): Promise<T | null> {
    const { base } = this.restBase();
    const res = await fetch(`${base}/rest/v1/${path}`, { headers: this.headers() });
    if (!res.ok) return null;
    return (await res.json()) as T;
  }

  private async post<T>(path: string, body: Record<string, unknown>): Promise<T | null> {
    const { base } = this.restBase();
    const res = await fetch(`${base}/rest/v1/${path}`, {
      method: "POST",
      headers: this.headers({ "Content-Type": "application/json", Prefer: "return=representation" }),
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new BadRequestException(`Payout insert failed (${res.status}): ${text}`);
    }
    return (await res.json()) as T;
  }

  private async del(path: string): Promise<void> {
    const { base } = this.restBase();
    const res = await fetch(`${base}/rest/v1/${path}`, { method: "DELETE", headers: this.headers() });
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new BadRequestException(`Payout delete failed (${res.status}): ${text}`);
    }
  }
}
