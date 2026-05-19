import { Injectable, UnauthorizedException } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { randomBytes } from "crypto";
import { PasswordService } from "./password.service";
import { RoleName, SessionService } from "./session.service";

export type ApiRole = "super_admin" | "restaurant_admin" | "driver" | "user";

export interface ApiUser {
  id: string;
  email: string;
  name: string;
  display_name: string;
  auth_provider: "email";
  avatar_url: string | null;
  lightning_pubkey: string | null;
  restaurant_id: string | null;
}

@Injectable()
export class AuthService {
  private passwordHash: string | null = null;
  private readonly resetTokens = new Map<string, { email: string; expiresAt: number }>();

  private readonly user: ApiUser = {
    id: "owned-user-frorex",
    email: "frorex.studio@gmail.com",
    name: "Frorex Studio",
    display_name: "Frorex",
    auth_provider: "email",
    avatar_url: null,
    lightning_pubkey: null,
    restaurant_id: null
  };

  private readonly roles: ApiRole[] = ["super_admin", "user"];

  constructor(
    private readonly passwords: PasswordService,
    private readonly sessions: SessionService,
    private readonly config: ConfigService
  ) {}

  async login(email: string, password: string) {
    if (email.trim().toLowerCase() !== this.user.email) {
      throw new UnauthorizedException("Invalid email or password");
    }

    await this.ensurePasswordHash();
    const isValid = await this.passwords.verify(password, this.passwordHash!);

    if (!isValid) {
      throw new UnauthorizedException("Invalid email or password");
    }

    const tokenPair = await this.sessions.createTokenPair({
      userId: this.user.id,
      roles: this.roles.map((role) => role.toUpperCase() as RoleName)
    });

    return {
      user: this.user,
      roles: this.roles,
      session: {
        access_token: tokenPair.accessToken,
        refresh_token: tokenPair.refreshToken,
        expires_at: Math.floor(Date.now() / 1000) + 900,
        user: this.user
      }
    };
  }

  async signUp(email: string, password: string, name?: string) {
    if (email.trim().toLowerCase() === this.user.email) {
      return this.login(email, password);
    }

    return {
      user: {
        id: `owned-user-${Date.now()}`,
        email,
        name: name || email,
        display_name: name || email,
        auth_provider: "email",
        avatar_url: null,
        lightning_pubkey: null,
        restaurant_id: null
      },
      roles: ["user"],
      session: null
    };
  }

  me() {
    return {
      user: this.user,
      roles: this.roles
    };
  }

  async requestPasswordReset(email: string, redirectUrl?: string) {
    const normalizedEmail = email.trim().toLowerCase();

    if (normalizedEmail !== this.user.email) {
      return {
        ok: true,
        email: normalizedEmail,
        resetToken: null,
        resetUrl: null,
        message: "If the account exists, reset instructions will be available."
      };
    }

    const resetToken = randomBytes(24).toString("hex");
    this.resetTokens.set(resetToken, {
      email: normalizedEmail,
      expiresAt: Date.now() + 1000 * 60 * 30
    });

    const resetUrl = this.buildResetUrl(resetToken, redirectUrl);
    const baseResponse = {
      ok: true,
      email: normalizedEmail,
      message: "If the account exists, reset instructions will be available."
    };

    if (this.isProduction()) {
      return { ...baseResponse, resetToken: null, resetUrl: null };
    }

    return { ...baseResponse, resetToken, resetUrl };
  }

  async confirmPasswordReset(token: string, password: string) {
    const reset = this.resetTokens.get(token);

    if (!reset || reset.email !== this.user.email || reset.expiresAt < Date.now()) {
      throw new UnauthorizedException("Invalid or expired reset token");
    }

    this.passwordHash = await this.passwords.hash(password);
    this.resetTokens.delete(token);

    return { success: true };
  }

  private async ensurePasswordHash() {
    if (!this.passwordHash) {
      const seedHash = this.config.get<string>("FROREX_SEED_PASSWORD_HASH")?.trim();
      const seedPassword = this.config.get<string>("FROREX_SEED_PASSWORD")?.trim();

      if (seedHash) {
        this.passwordHash = seedHash;
        return;
      }

      if (this.isProduction() && !seedPassword) {
        throw new Error("FROREX_SEED_PASSWORD_HASH or FROREX_SEED_PASSWORD must be set in production");
      }

      this.passwordHash = await this.passwords.hash(seedPassword || "111111");
    }
  }

  private buildResetUrl(resetToken: string, redirectUrl?: string) {
    const base = this.safeResetBaseUrl(redirectUrl);
    base.searchParams.set("token", resetToken);
    return base.toString();
  }

  private safeResetBaseUrl(redirectUrl?: string) {
    const fallback = this.config.get<string>("APP_RESET_PASSWORD_URL") || "http://localhost:8080/reset-password";
    const allowedOrigins = this.allowedRedirectOrigins();

    try {
      const requested = new URL(redirectUrl || fallback);
      if (allowedOrigins.has(requested.origin)) {
        return requested;
      }
    } catch {
      // Use the configured fallback below.
    }

    return new URL(fallback);
  }

  private allowedRedirectOrigins() {
    const configured = (this.config.get<string>("APP_ALLOWED_REDIRECT_ORIGINS") || "")
      .split(",")
      .map((origin) => origin.trim())
      .filter(Boolean);

    const origins = new Set(configured);

    if (!this.isProduction()) {
      origins.add("http://localhost:8080");
      origins.add("http://127.0.0.1:8080");
      origins.add("http://localhost:8081");
      origins.add("http://127.0.0.1:8081");
    }

    return origins;
  }

  private isProduction() {
    return this.config.get<string>("NODE_ENV") === "production";
  }
}
