import { Injectable, Logger } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { createHash } from "crypto";
import { SessionService } from "../auth/session.service";
import { MembershipService } from "../membership/membership.service";
import type { SubscriptionView } from "../membership/subscription-view";

// Re-exported for back-compat with existing importers.
export type { AccessStatus, SubscriptionView } from "../membership/subscription-view";
/** @deprecated use SubscriptionView from the membership domain. */
export type NormalizedSubscription = SubscriptionView;

export interface VerifiedUser {
  id: string;
  name: string;
  avatar_url: string | null;
}

export interface VerifyAccessResult {
  ok: boolean;
  allowed: boolean;
  reason: string;
  user: VerifiedUser | null;
  subscriptions: SubscriptionView[];
}

interface VerifyMeta {
  ip?: string | null;
  userAgent?: string | null;
}

/**
 * QR access verification. The access DECISION is delegated to the Membership
 * PDP (`evaluateAccess`); this service only decodes the token, resolves the
 * subject for display, and writes the audit log.
 */
@Injectable()
export class VerifyService {
  private readonly logger = new Logger(VerifyService.name);

  constructor(
    private readonly sessions: SessionService,
    private readonly config: ConfigService,
    private readonly membership: MembershipService
  ) {}

  /** Mint a short-lived signed token for the current user's profile QR code. */
  mintToken(userId: string) {
    const ttl = Number(this.config.get("VERIFY_TOKEN_TTL_SECONDS") ?? 300);
    const { token, expiresIn } = this.sessions.createVerifyToken(userId, ttl);
    return { token, expires_in: expiresIn };
  }

  /**
   * Verify a scanned QR token and return the user's access status with their
   * full subscription list. Always logs the attempt (success or failure).
   */
  async verifyAccess(token: string, meta: VerifyMeta = {}): Promise<VerifyAccessResult> {
    const tokenHash = token ? createHash("sha256").update(token).digest("hex") : null;

    // 1. Verify and decode the token.
    let userId: string;
    try {
      userId = this.sessions.verifyVerifyToken(token).sub;
    } catch {
      const reason = "Invalid or expired QR code";
      await this.log({ tokenHash, userId: null, result: "invalid_token", reason, allowed: false, count: 0, meta });
      return { ok: false, allowed: false, reason, user: null, subscriptions: [] };
    }

    // 2. Find the user.
    const user = await this.fetchUser(userId);
    if (!user) {
      const reason = "User not found";
      await this.log({ tokenHash, userId, result: "denied", reason, allowed: false, count: 0, meta });
      return { ok: false, allowed: false, reason, user: null, subscriptions: [] };
    }

    // 3. Access decision — Membership PDP is the single authority.
    const decision = await this.membership.evaluateAccess(userId);
    const { permit: allowed, reason, subscriptions } = decision;

    // 4. Audit log.
    await this.log({
      tokenHash,
      userId,
      result: allowed ? "allowed" : "denied",
      reason,
      allowed,
      count: subscriptions.length,
      meta
    });

    return { ok: true, allowed, reason, user, subscriptions };
  }

  // ─── Subject lookup + audit (verify-specific) ────────────────────────────────

  private async fetchUser(userId: string): Promise<VerifiedUser | null> {
    const rows = await this.rest<Array<{ id: string; name: string | null; display_name: string | null; avatar_url: string | null }>>(
      `users?select=id,name,display_name,avatar_url&id=eq.${encodeURIComponent(userId)}&limit=1`
    );
    const row = rows?.[0];
    if (!row) return null;
    return {
      id: row.id,
      name: row.display_name || row.name || "Unknown user",
      avatar_url: row.avatar_url ?? null
    };
  }

  private async rest<T>(path: string): Promise<T | null> {
    const base = this.config.get<string>("SUPABASE_URL")?.replace(/\/$/, "");
    const key =
      this.config.get<string>("SUPABASE_SERVICE_ROLE_KEY") || this.config.get<string>("SUPABASE_ANON_KEY");
    if (!base || !key) return null;
    try {
      const res = await fetch(`${base}/rest/v1/${path}`, {
        headers: { apikey: key, Authorization: `Bearer ${key}` }
      });
      if (!res.ok) {
        this.logger.warn(`[verify.rest] ${path} → ${res.status}`);
        return null;
      }
      return (await res.json()) as T;
    } catch (err) {
      this.logger.error(`[verify.rest] ${path} network error: ${(err as Error).message}`);
      return null;
    }
  }

  private async log(entry: {
    tokenHash: string | null;
    userId: string | null;
    result: "allowed" | "denied" | "invalid_token";
    reason: string;
    allowed: boolean;
    count: number;
    meta: VerifyMeta;
  }): Promise<void> {
    const base = this.config.get<string>("SUPABASE_URL")?.replace(/\/$/, "");
    const key =
      this.config.get<string>("SUPABASE_SERVICE_ROLE_KEY") || this.config.get<string>("SUPABASE_ANON_KEY");
    if (!base || !key) return;
    try {
      await fetch(`${base}/rest/v1/access_verification_logs`, {
        method: "POST",
        headers: {
          apikey: key,
          Authorization: `Bearer ${key}`,
          "Content-Type": "application/json",
          Prefer: "return=minimal"
        },
        body: JSON.stringify({
          token_hash: entry.tokenHash,
          user_id: entry.userId,
          result: entry.result,
          reason: entry.reason,
          allowed: entry.allowed,
          subscription_count: entry.count,
          ip: entry.meta.ip ?? null,
          user_agent: entry.meta.userAgent ?? null
        })
      });
    } catch (err) {
      this.logger.warn(`[verify.log] failed: ${(err as Error).message}`);
    }
  }
}
