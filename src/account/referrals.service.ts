import { BadRequestException, Injectable, Logger } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";

/**
 * "Bring a neighbour."
 *
 * Both halves of a referral are deliberately in different places, because they
 * have different threat models:
 *
 *   attribution — WHO invited whom — lives here, behind AccountAuthGuard. The
 *     caller is the person being referred and the server knows it from their
 *     token, so nobody can name themselves as somebody else's referrer.
 *
 *   the reward — is decided by a DB trigger (`referrals_on_order_paid`), not by
 *     this service. An order is marked paid by three separate writers (the
 *     browser at checkout, the reconcile cron, the Blink webhook) and only the
 *     database sees all three. Same reasoning that put mirror_legacy_occurrence
 *     on a trigger.
 *
 * So this file never grants credit. It reads a balance and it records who
 * invited whom; the money happens where the payment does.
 */

export interface ReferralSummary {
  enabled: boolean;
  code: string | null;
  rewardCents: number;
  welcomeCents: number;
  balanceCents: number;
  earnedCents: number;
  invited: Array<{ name: string; status: string; joinedAt: string }>;
  credits: Array<{ amountCents: number; reason: string; note: string | null; createdAt: string }>;
}

@Injectable()
export class ReferralsService {
  private readonly logger = new Logger(ReferralsService.name);

  constructor(private readonly config: ConfigService) {}

  async summary(userId: string): Promise<ReferralSummary> {
    const settings = await this.settings();

    const [me] = await this.rest<Array<{ referral_code: string | null }>>(
      `/users?id=eq.${encodeURIComponent(userId)}&select=referral_code&limit=1`,
    ) ?? [];

    const rows = await this.rest<Array<{
      referee_user_id: string; status: string; created_at: string;
    }>>(
      `/referrals?referrer_user_id=eq.${encodeURIComponent(userId)}` +
      `&select=referee_user_id,status,created_at&order=created_at.desc&limit=100`,
    ) ?? [];

    const credits = await this.rest<Array<{
      amount_cents: number; reason: string; note: string | null; created_at: string;
    }>>(
      `/user_credits?user_id=eq.${encodeURIComponent(userId)}` +
      `&select=amount_cents,reason,note,created_at&order=created_at.desc&limit=100`,
    ) ?? [];

    return {
      enabled: settings.enabled,
      code: me?.referral_code ?? null,
      rewardCents: settings.rewardCents,
      welcomeCents: settings.welcomeCents,
      balanceCents: credits.reduce((sum, c) => sum + (Number(c.amount_cents) || 0), 0),
      earnedCents: credits
        .filter((c) => c.reason === "referral_reward")
        .reduce((sum, c) => sum + (Number(c.amount_cents) || 0), 0),
      // First names only. The referrer invited these people and should see who
      // turned up, but a referral list is not a reason to hand out addresses.
      invited: (await this.namesOf(rows.map((r) => r.referee_user_id))).map((name, i) => ({
        name,
        status: rows[i].status,
        joinedAt: rows[i].created_at,
      })),
      credits: credits.map((c) => ({
        amountCents: Number(c.amount_cents) || 0,
        reason: c.reason,
        note: c.note,
        createdAt: c.created_at,
      })),
    };
  }

  /**
   * Record that `userId` arrived on someone's code.
   *
   * Every rule here exists because the alternative pays somebody for nothing:
   * a code has to belong to a real other person, you only get referred once in
   * your life, and you cannot be back-attributed after you have already bought
   * something — otherwise the first thing anyone would do is claim the
   * customers the platform already had.
   */
  async claim(userId: string, rawCode: string): Promise<{ claimed: boolean; reason?: string }> {
    const settings = await this.settings();
    if (!settings.enabled) return { claimed: false, reason: "disabled" };

    const code = String(rawCode || "").trim().toUpperCase();
    if (!/^[A-Z0-9]{4,12}$/.test(code)) throw new BadRequestException("That is not a referral code.");

    const [referrer] = await this.rest<Array<{ id: string }>>(
      `/users?referral_code=eq.${encodeURIComponent(code)}&deleted_at=is.null&select=id&limit=1`,
    ) ?? [];
    if (!referrer) return { claimed: false, reason: "unknown-code" };
    if (referrer.id === userId) return { claimed: false, reason: "self" };

    const existing = await this.rest<Array<{ id: string }>>(
      `/referrals?referee_user_id=eq.${encodeURIComponent(userId)}&select=id&limit=1`,
    ) ?? [];
    if (existing.length) return { claimed: false, reason: "already-referred" };

    if (await this.hasPaidOrder(userId)) return { claimed: false, reason: "already-a-customer" };

    try {
      await this.rest(`/referrals`, {
        method: "POST",
        headers: { Prefer: "resolution=ignore-duplicates" },
        body: JSON.stringify({
          referrer_user_id: referrer.id,
          referee_user_id: userId,
          code,
          status: "pending",
        }),
      });
    } catch (err) {
      // The unique index on referee_user_id is the real guard; losing a race
      // against it is a no-op, not an error the new user should ever see.
      this.logger.warn(`referral claim failed for ${userId}: ${(err as Error).message}`);
      return { claimed: false, reason: "already-referred" };
    }

    return { claimed: true };
  }

  // ─── plumbing ───────────────────────────────────────────────────────────────

  /** Has this person ever paid for anything? Checks every order table. */
  private async hasPaidOrder(userId: string): Promise<boolean> {
    const tables = [
      "cleaning_subscriptions",
      "food_subscriptions",
      "provider_subscriptions",
      "rental_bookings",
    ];
    for (const table of tables) {
      const rows = await this.rest<Array<{ id: string }>>(
        `/${table}?user_id=eq.${encodeURIComponent(userId)}&payment_status=eq.paid&select=id&limit=1`,
      ).catch(() => []);
      if (rows?.length) return true;
    }
    return false;
  }

  private async namesOf(ids: string[]): Promise<string[]> {
    if (!ids.length) return [];
    const rows = await this.rest<Array<{ id: string; name: string | null; display_name: string | null }>>(
      `/users?id=in.(${ids.map((id) => encodeURIComponent(id)).join(",")})&select=id,name,display_name`,
    ) ?? [];
    const byId = new Map(rows.map((r) => [r.id, r]));
    return ids.map((id) => {
      const row = byId.get(id);
      const full = (row?.display_name || row?.name || "").trim();
      return full ? full.split(/\s+/)[0] : "Someone";
    });
  }

  private async settings(): Promise<{ enabled: boolean; rewardCents: number; welcomeCents: number }> {
    const rows = await this.rest<Array<{ key: string; value: unknown }>>(
      `/global_settings?key=in.(referral_enabled,referral_reward_cents,referral_welcome_cents)&select=key,value`,
    ).catch(() => []) ?? [];
    const at = (key: string) => rows.find((r) => r.key === key)?.value;
    const int = (key: string, fallback: number) => {
      const n = Number(at(key));
      return Number.isFinite(n) && n >= 0 ? Math.round(n) : fallback;
    };
    return {
      enabled: at("referral_enabled") !== false,
      rewardCents: int("referral_reward_cents", 1000),
      welcomeCents: int("referral_welcome_cents", 1000),
    };
  }

  private async rest<T>(path: string, init: RequestInit = {}): Promise<T | null> {
    const url = this.config.get<string>("SUPABASE_URL");
    const key = this.config.get<string>("SUPABASE_SERVICE_ROLE_KEY");
    // referrals and user_credits are service-role only on purpose; falling back
    // to the anon key would read an empty list and call it "no referrals".
    if (!url || !key) {
      this.logger.warn("Supabase service credentials are missing; referrals are disabled.");
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
