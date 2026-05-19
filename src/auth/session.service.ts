import { Injectable } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import * as crypto from "crypto";
import * as jwt from "jsonwebtoken";

export type RoleName = "SUPER_ADMIN" | "RESTAURANT_ADMIN" | "DRIVER" | "USER";

interface TokenInput {
  userId: string;
  roles: RoleName[];
}

interface AccessPayload extends jwt.JwtPayload {
  sub: string;
  roles: RoleName[];
  typ: "access";
}

@Injectable()
export class SessionService {
  private readonly localAccessSecret = "dev-only-access-secret-change-before-production-2026";
  private readonly localRefreshSecret = "dev-only-refresh-secret-change-before-production-2026";

  constructor(private readonly config: ConfigService) {}

  async createTokenPair(input: TokenInput) {
    const accessTtl = Number(this.config.get("ACCESS_TOKEN_TTL_SECONDS") ?? 900);
    const refreshTtl = Number(this.config.get("REFRESH_TOKEN_TTL_SECONDS") ?? 2592000);
    const now = Date.now();

    const accessToken = jwt.sign(
      {
        roles: input.roles,
        typ: "access"
      },
      this.accessSecret(),
      {
        subject: input.userId,
        expiresIn: accessTtl
      }
    );

    const refreshToken = jwt.sign(
      {
        typ: "refresh"
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

  async hashRefreshToken(token: string): Promise<string> {
    return crypto.createHash("sha256").update(token).digest("hex");
  }

  private accessSecret(): string {
    return this.secret("JWT_ACCESS_SECRET", this.localAccessSecret);
  }

  private refreshSecret(): string {
    return this.secret("JWT_REFRESH_SECRET", this.localRefreshSecret);
  }

  private secret(name: "JWT_ACCESS_SECRET" | "JWT_REFRESH_SECRET", fallback: string): string {
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
