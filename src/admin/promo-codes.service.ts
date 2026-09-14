import { BadRequestException, Injectable, Logger, NotFoundException } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";

/**
 * Making and retiring promo codes.
 *
 * The table is service-role only, which is the whole point: the admin panel
 * writes from the browser with the public anon key, so a promo table the
 * browser could write would let anyone holding that key mint themselves a
 * hundred percent off. Creating a code therefore goes through here, and the
 * customer-facing half — `promo_quote` and the guard trigger — needs nothing
 * from this file at all.
 *
 * Editing is deliberately limited. A code's VALUE and its scope are fixed once
 * created: somebody may already have been quoted it, and changing what
 * "SUMMER20" means underneath them is worse than making "SUMMER25". What can
 * change is whether it is still going — the status, the window, and the caps.
 */

export interface PromoRow {
  id: string;
  code: string;
  description: string | null;
  kind: "percent" | "fixed";
  percent_off: number | null;
  amount_off_cents: number | null;
  provider_id: string | null;
  archetype_key: string | null;
  min_order_cents: number;
  max_redemptions: number | null;
  per_customer_limit: number;
  starts_at: string | null;
  ends_at: string | null;
  status: string;
  created_at: string;
}

@Injectable()
export class PromoCodesService {
  private readonly logger = new Logger(PromoCodesService.name);

  constructor(private readonly config: ConfigService) {}

  /** Every code, with how many times each has actually been used. */
  async list() {
    const [codes, redemptions] = await Promise.all([
      this.rest<PromoRow[]>(`/promo_codes?select=*&order=created_at.desc`),
      this.rest<Array<{ promo_id: string; discount_cents: number }>>(
        `/promo_redemptions?select=promo_id,discount_cents`,
      ),
    ]);

    const used = new Map<string, { count: number; cents: number }>();
    for (const r of redemptions ?? []) {
      const prev = used.get(r.promo_id) ?? { count: 0, cents: 0 };
      used.set(r.promo_id, {
        count: prev.count + 1,
        cents: prev.cents + (Number(r.discount_cents) || 0),
      });
    }

    return (codes ?? []).map((c) => ({
      ...c,
      redemptions: used.get(c.id)?.count ?? 0,
      // What the platform has given away on this code so far — the number
      // worth looking at when deciding whether to leave it running.
      given_away_cents: used.get(c.id)?.cents ?? 0,
    }));
  }

  async create(input: Record<string, any>, adminUserId?: string) {
    const code = String(input.code ?? "").trim().toUpperCase();
    if (!/^[A-Z0-9]{3,24}$/.test(code)) {
      throw new BadRequestException("A code is 3–24 letters and digits, nothing else — it gets read aloud.");
    }

    const kind = input.kind === "fixed" ? "fixed" : "percent";
    const percent = kind === "percent" ? Math.round(Number(input.percent_off)) : null;
    const amount = kind === "fixed" ? Math.round(Number(input.amount_off_cents)) : null;

    if (kind === "percent" && !(percent! >= 1 && percent! <= 100)) {
      throw new BadRequestException("A percentage is between 1 and 100.");
    }
    if (kind === "fixed" && !(amount! > 0)) {
      throw new BadRequestException("A fixed discount has to be more than nothing.");
    }

    const row = {
      code,
      description: String(input.description ?? "").trim() || null,
      kind,
      percent_off: percent,
      amount_off_cents: amount,
      provider_id: input.provider_id || null,
      archetype_key: input.archetype_key || null,
      min_order_cents: Math.max(0, Math.round(Number(input.min_order_cents) || 0)),
      max_redemptions: input.max_redemptions ? Math.max(1, Math.round(Number(input.max_redemptions))) : null,
      per_customer_limit: Math.max(0, Math.round(Number(input.per_customer_limit ?? 1))),
      starts_at: input.starts_at || null,
      ends_at: input.ends_at || null,
      status: "active",
      created_by: adminUserId ?? null,
    };

    try {
      const created = await this.rest<PromoRow[]>(`/promo_codes`, {
        method: "POST",
        headers: { Prefer: "return=representation" },
        body: JSON.stringify(row),
      });
      this.logger.log(`promo ${code} created by ${adminUserId ?? "unknown"}`);
      return created?.[0] ?? null;
    } catch (err) {
      if (/duplicate key|promo_codes_code_uidx/i.test((err as Error).message)) {
        throw new BadRequestException(`${code} already exists.`);
      }
      throw err;
    }
  }

  /**
   * Only what is safe to change under somebody who already has the code.
   *
   * The value and the scope are not in this list on purpose — see the class
   * comment. Turning a code off is the honest way to stop it.
   */
  async update(id: string, input: Record<string, any>) {
    const patch: Record<string, unknown> = { updated_at: new Date().toISOString() };
    if (input.status !== undefined) {
      if (!["active", "inactive"].includes(input.status)) throw new BadRequestException("Unknown status.");
      patch.status = input.status;
    }
    if (input.description !== undefined) patch.description = String(input.description).trim() || null;
    if (input.ends_at !== undefined) patch.ends_at = input.ends_at || null;
    if (input.starts_at !== undefined) patch.starts_at = input.starts_at || null;
    if (input.max_redemptions !== undefined) {
      patch.max_redemptions = input.max_redemptions ? Math.max(1, Math.round(Number(input.max_redemptions))) : null;
    }
    if (input.per_customer_limit !== undefined) {
      patch.per_customer_limit = Math.max(0, Math.round(Number(input.per_customer_limit)));
    }

    const rows = await this.rest<PromoRow[]>(
      `/promo_codes?id=eq.${encodeURIComponent(id)}`,
      { method: "PATCH", headers: { Prefer: "return=representation" }, body: JSON.stringify(patch) },
    );
    if (!rows?.length) throw new NotFoundException("No such code.");
    return rows[0];
  }

  /**
   * Deleting is allowed only while nobody has used it.
   *
   * A redeemed code is part of why an order cost what it cost; removing it
   * would leave orders pointing at a discount that no longer explains itself.
   */
  async remove(id: string) {
    const used = await this.rest<Array<{ id: string }>>(
      `/promo_redemptions?promo_id=eq.${encodeURIComponent(id)}&select=id&limit=1`,
    );
    if (used?.length) {
      throw new BadRequestException("This code has been used — switch it off instead of deleting it.");
    }
    await this.rest(`/promo_codes?id=eq.${encodeURIComponent(id)}`, { method: "DELETE" });
    return { ok: true };
  }

  private async rest<T>(path: string, init: RequestInit = {}): Promise<T | null> {
    const url = this.config.get<string>("SUPABASE_URL");
    const key = this.config.get<string>("SUPABASE_SERVICE_ROLE_KEY");
    if (!url || !key) throw new BadRequestException("Supabase service credentials are missing.");
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
