import { BadRequestException, HttpException, HttpStatus, Injectable, Logger, UnauthorizedException } from "@nestjs/common";
import { AuthService } from "../auth/auth.service";
import { PasswordService } from "../auth/password.service";
import { AccountNotificationsService } from "./account-notifications.service";

interface RateLimitEntry {
  attempts: number;
  resetAt: number;
}

const MAX_ATTEMPTS = 5;
const WINDOW_MS = 15 * 60 * 1000; // 15 minutes

@Injectable()
export class AccountPasswordService {
  private readonly logger = new Logger(AccountPasswordService.name);

  /** Simple in-memory rate limiter: userId → { attempts, resetAt } */
  private readonly rateLimits = new Map<string, RateLimitEntry>();

  constructor(
    private readonly auth: AuthService,
    private readonly passwords: PasswordService,
    private readonly notifications: AccountNotificationsService,
  ) {}

  // ─── Rate limiter ─────────────────────────────────────────────────────────

  private checkRateLimit(userId: string) {
    const now = Date.now();
    const entry = this.rateLimits.get(userId);

    if (!entry || entry.resetAt < now) {
      this.rateLimits.set(userId, { attempts: 1, resetAt: now + WINDOW_MS });
      return;
    }

    if (entry.attempts >= MAX_ATTEMPTS) {
      const waitSec = Math.ceil((entry.resetAt - now) / 1000);
      throw new HttpException(
        `Too many password change attempts. Try again in ${waitSec} seconds.`,
        HttpStatus.TOO_MANY_REQUESTS,
      );
    }

    entry.attempts += 1;
  }

  private clearRateLimit(userId: string) {
    this.rateLimits.delete(userId);
  }

  // ─── Change password ──────────────────────────────────────────────────────

  async changePassword(
    userId: string,
    currentPassword: string,
    newPassword: string,
  ): Promise<{ ok: boolean }> {
    // ── Validation ──────────────────────────────────────────────────────────
    if (!currentPassword?.trim()) throw new BadRequestException("Current password is required.");
    if (!newPassword?.trim()) throw new BadRequestException("New password is required.");
    if (newPassword.length < 8) throw new BadRequestException("New password must be at least 8 characters.");
    if (currentPassword === newPassword) throw new BadRequestException("New password must be different from your current password.");

    // ── Rate limit ──────────────────────────────────────────────────────────
    this.checkRateLimit(userId);

    // ── Load user to get email + auth_provider ──────────────────────────────
    const user = await this.auth.getUserById(userId);
    if (!user) throw new UnauthorizedException("User not found.");

    // ── Block non-email accounts ────────────────────────────────────────────
    if (user.auth_provider === "google") {
      throw new BadRequestException(
        "Password login is not enabled for this account. Your account uses Google sign-in.",
      );
    }
    if ((user.auth_provider as string) === "lightning") {
      throw new BadRequestException(
        "Password login is not enabled for this account. Your account uses Lightning authentication.",
      );
    }

    // ── Verify current password ─────────────────────────────────────────────
    const valid = await this.auth.verifyCurrentPassword(user.email, currentPassword);
    if (!valid) {
      throw new UnauthorizedException("Current password is incorrect.");
    }

    // ── Update password ─────────────────────────────────────────────────────
    await this.auth.updatePassword(user.email, newPassword);

    // ── Clear rate limit on success ─────────────────────────────────────────
    this.clearRateLimit(userId);

    // ── Security notification (fire & forget) ───────────────────────────────
    void this.notifications.create({
      recipientUserId: userId,
      category: "reminder",
      type: "reminder_general",
      title: "Password changed",
      body: "Your account password was updated successfully. If this wasn't you, contact support immediately.",
      actionUrl: "/notifications",
    }).catch((err) => this.logger.warn(`Password change notification failed: ${(err as Error).message}`));

    return { ok: true };
  }
}
