import { Injectable } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import * as crypto from "crypto";
import * as jwt from "jsonwebtoken";

export type RoleName = "SUPER_ADMIN" | "USER";

interface TokenInput {
  userId: string;
  roles: RoleName[];
  email?: string;
  name?: string;
  authProvider?: string;
  avatarUrl?: string | null;
}

interface AccessPayload extends jwt.JwtPayload {
  sub: string;
  roles: RoleName[];
  typ: "access";
  email?: string;
  name?: string;
  authProvider?: string;
  avatarUrl?: string | null;
}

interface RefreshPayload extends jwt.JwtPayload {
  sub: string;
  typ: "refresh";
  roles?: RoleName[];
  email?: string;
  name?: string;
  authProvider?: string;
  avatarUrl?: string | null;
}

@Injectable()
export class SessionService {
  private readonly localAccessSecret = "dev-only-access-secret-change-before-production-2026";
  private readonly localRefreshSecret = "dev-only-refresh-secret-change-before-production-2026";
  private readonly localVerifySecret = "dev-only-verify-secret-change-before-production-2026";

  constructor(private readonly config: ConfigService) {}

  async createTokenPair(input: TokenInput) {
    const accessTtl = Number(this.config.get("ACCESS_TOKEN_TTL_SECONDS") ?? 900);
    const refreshTtl = Number(this.config.get("REFRESH_TOKEN_TTL_SECONDS") ?? 2592000);
    const now = Date.now();

    const accessToken = jwt.sign(
      {
        roles: input.roles,
        typ: "access",
        email: input.email,
        name: input.name,
        authProvider: input.authProvider,
        avatarUrl: input.avatarUrl ?? null
      },
      this.accessSecret(),
      {
        subject: input.userId,
        expiresIn: accessTtl
      }
    );

    const refreshToken = jwt.sign(
      {
        typ: "refresh",
        roles: input.roles,
        email: input.email,
        name: input.name,
        authProvider: input.authProvider,
        avatarUrl: input.avatarUrl ?? null
      },
      this.refreshSecret(),
      {
        subject: input.userId,
        expiresIn: refreshTtl
      }
    );

    return {
      accessToken,
      refreshToken,
      refreshTokenHash: await this.hashRefreshToken(refreshToken),
      refreshExpiresAt: new Date(now + refreshTtl * 1000)
    };
  }

  verifyAccessToken(token: string): AccessPayload {
    return jwt.verify(token, this.accessSecret()) as AccessPayload;
  }

  verifyRefreshToken(token: string): RefreshPayload {
    return jwt.verify(token, this.refreshSecret()) as RefreshPayload;
  }

  /**
   * Sign a short-lived, single-purpose "access verification" token for a user's
   * profile QR code. Uses a SEPARATE secret from access/refresh tokens so a
   * verify token can never be replayed as a session token.
   */
  createVerifyToken(userId: string, ttlSeconds = 300): { token: string; expiresIn: number } {
    const token = jwt.sign({ typ: "verify" }, this.verifySecret(), {
      subject: userId,
      expiresIn: ttlSeconds
    });
    return { token, expiresIn: ttlSeconds };
  }

  verifyVerifyToken(token: string): { sub: string; typ: string } {
    const payload = jwt.verify(token, this.verifySecret()) as jwt.JwtPayload;
    if (payload.typ !== "verify" || !payload.sub) {
      throw new Error("Invalid verification token");
    }
    return { sub: payload.sub, typ: "verify" };
  }

  /**
   * Password-reset token.
   *
   * Signed rather than stored. The previous implementation kept tokens in an
   * in-memory Map on the service instance — the code even said "valid only
   * within the same Lambda instance". On serverless the lambda that sends the
   * email is almost never the one that handles the click minutes later, so
   * every reset link answered "Invalid or expired reset token". Password reset
   * has been structurally broken in production, not occasionally flaky.
   *
   * Signing removes the storage entirely: any instance can verify it. Uses the
   * same separate secret as the verify token, so a reset token can never be
   * replayed as a session token.
   *
   * Trade-off worth knowing: without a store there is nothing to mark as used,
   * so the link works more than once inside its 30-minute window. That is the
   * same exposure the email itself carries, and it replaces a link that worked
   * zero times. Making it strictly single-use needs a revocation table.
   */
  createPasswordResetToken(email: string, ttlSeconds = 1800) {
    const token = jwt.sign({ typ: "pwreset" }, this.verifySecret(), {
      subject: email,
      expiresIn: ttlSeconds
    });
    return { token, expiresIn: ttlSeconds };
  }

  verifyPasswordResetToken(token: string): { email: string } {
    const payload = jwt.verify(token, this.verifySecret()) as jwt.JwtPayload;
    if (payload.typ !== "pwreset" || !payload.sub) {
      throw new Error("Invalid password reset token");
    }
    return { email: String(payload.sub) };
  }

  async hashRefreshToken(token: string): Promise<string> {
    return crypto.createHash("sha256").update(token).digest("hex");
  }

  private accessSecret(): string {
    return this.secret("JWT_ACCESS_SECRET", this.localAccessSecret);
  }

  private refreshSecret(): string {
    return this.secret("JWT_REFRESH_SECRET", this.localRefreshSecret);
  }

  private verifySecret(): string {
    return this.secret("JWT_VERIFY_SECRET", this.localVerifySecret);
  }

  private secret(name: "JWT_ACCESS_SECRET" | "JWT_REFRESH_SECRET" | "JWT_VERIFY_SECRET", fallback: string): string {
    const configured = this.config.get<string>(name)?.trim();
    const isProduction = this.config.get<string>("NODE_ENV") === "production";

    if (configured && configured.length >= 32) {
      return configured;
    }

    if (isProduction) {
      throw new Error(`${name} must be set to a unique value with at least 32 characters`);
    }

    return configured || fallback;
  }
}
