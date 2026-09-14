import { BadRequestException, Injectable, Logger, NotFoundException } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";

/**
 * Putting credit on somebody's account by hand.
 *
 * `user_credits` arrived with referrals and is service-role only on purpose —
 * it decides who gets money, so the browser reads it through the API or not at
 * all. The consequence was that an admin could not compensate anybody: a
 * ruined delivery, a court that was double-booked, a goodwill gesture after a
 * complaint all had to be done in SQL or not done.
 *
 * Deliberately narrow. It grants and it takes back, it always records why and
 * who, and it refuses to take more than the person has — that last one is the
 * database's own guard (`user_credits_guard_balance`), which this does not try
 * to talk around.
 */

@Injectable()
export class CustomerCreditsService {
  private readonly logger = new Logger(CustomerCreditsService.name);

  constructor(private readonly config: ConfigService) {}

  /** What they hold and where it came from. */
  async ledger(userId: string) {
    const rows = await this.rest<Array<{
      amount_cents: number; reason: string; note: string | null; created_at: string;
    }>>(
      `/user_credits?user_id=eq.${encodeURIComponent(userId)}` +
      `&select=amount_cents,reason,note,created_at&order=created_at.desc&limit=200`,
    ) ?? [];
    return {
      balanceCents: rows.reduce((sum, r) => sum + (Number(r.amount_cents) || 0), 0),
      entries: rows.map((r) => ({
        amountCents: Number(r.amount_cents) || 0,
        reason: r.reason,
        note: r.note,
        createdAt: r.created_at,
      })),
    };
  }

  /**
   * Move a customer's balance.
   *
   * A positive amount is a grant, a negative one takes it back. Both are the
   * same verb because both are the same row — a ledger that could only be
   * added to would drift away from the truth the first time somebody made a
   * mistake.
   */
  async adjust(input: {
    userId: string;
    amountCents: number;
    note: string;
    adminUserId?: string;
  }) {
    const amount = Math.round(input.amountCents);
    if (!Number.isFinite(amount) || amount === 0) {
      throw new BadRequestException("An adjustment has to be more than nothing.");
    }
    if (Math.abs(amount) > 100_000) {
      // A thousand dollars by hand is a decision, not a typo — and a typo is
      // exactly what an unbounded field invites.
      throw new BadRequestException("That is over $1,000 — do it in smaller steps if you mean it.");
    }
    if (!input.note?.trim()) {
      throw new BadRequestException("Say what this is for — it is the only record.");
    }

    const [user] = await this.rest<Array<{ id: string }>>(
      `/users?id=eq.${encodeURIComponent(input.userId)}&select=id&limit=1`,
    ) ?? [];
    if (!user) throw new NotFoundException("No such customer.");

    try {
      await this.rest(`/user_credits`, {
        method: "POST",
        body: JSON.stringify({
          user_id: input.userId,
          amount_cents: amount,
          reason: "admin_adjustment",
          note: `${input.note.trim()}${input.adminUserId ? ` (by ${input.adminUserId})` : ""}`,
        }),
      });
    } catch (err) {
      const msg = (err as Error).message ?? "";
      // The database refuses a spend that would take the balance below zero;
      // that is a sentence for the admin, not a 500.
      if (msg.includes("credit balance too low")) {
        throw new BadRequestException("That is more than this customer is holding.");
      }
      throw err;
    }

    this.logger.log(`credit ${amount} for ${input.userId} by ${input.adminUserId ?? "unknown"}`);
    return this.ledger(input.userId);
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
