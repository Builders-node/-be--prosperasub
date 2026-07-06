import { CanActivate, ExecutionContext, Injectable, ServiceUnavailableException, UnauthorizedException } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { timingSafeEqual } from "crypto";

/**
 * Protects the public payments API. Callers must send the shared key via
 * `x-api-key: <key>` or `Authorization: Bearer <key>`.
 */
@Injectable()
export class PublicApiKeyGuard implements CanActivate {
  constructor(private readonly config: ConfigService) {}

  canActivate(context: ExecutionContext): boolean {
    const expected = (this.config.get<string>("PUBLIC_PAYMENTS_API_KEY") || "").trim();
    if (!expected) {
      throw new ServiceUnavailableException("Public payments API is not configured.");
    }

    const req = context.switchToHttp().getRequest();
    const header = (req.headers["x-api-key"] || req.headers["authorization"] || "") as string;
    const provided = header.replace(/^Bearer\s+/i, "").trim();

    if (!provided || !this.safeEqual(provided, expected)) {
      throw new UnauthorizedException("Invalid or missing API key.");
    }
    return true;
  }

  private safeEqual(a: string, b: string): boolean {
    const ab = Buffer.from(a);
    const bb = Buffer.from(b);
    if (ab.length !== bb.length) return false;
    return timingSafeEqual(ab, bb);
  }
}
