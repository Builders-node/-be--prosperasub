import { CanActivate, ExecutionContext, Injectable, Logger, UnauthorizedException } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import type { Request } from "express";

/**
 * Shared-secret guard for the Builders Node integration endpoint.
 *
 * Auth is a single opaque bearer token — the same value on both sides,
 * stored in `BUILDERS_NODE_API_SECRET` here and mirrored in Builders Node's
 * env. It's a partner API, not a per-user session, so a single symmetric
 * secret is enough (there's no user identity to prove).
 *
 * Constant-time compare + a hard fail when the secret isn't configured so
 * a dev-mode env with an empty string doesn't silently let all traffic in.
 */
@Injectable()
export class BuildersNodeGuard implements CanActivate {
  private readonly logger = new Logger(BuildersNodeGuard.name);

  constructor(private readonly config: ConfigService) {}

  canActivate(context: ExecutionContext): boolean {
    const secret = this.config.get<string>("BUILDERS_NODE_API_SECRET")?.trim();
    if (!secret) {
      this.logger.error("BUILDERS_NODE_API_SECRET is not configured — refusing all traffic");
      throw new UnauthorizedException("Integration endpoint is not configured");
    }

    const request = context.switchToHttp().getRequest<Request>();
    const header = request.headers.authorization ?? "";
    const [scheme, token] = header.split(" ");
    if (scheme?.toLowerCase() !== "bearer" || !token) {
      throw new UnauthorizedException("Missing bearer token");
    }

    if (!constantTimeEquals(token, secret)) {
      throw new UnauthorizedException("Invalid integration token");
    }

    return true;
  }
}

// Length-first equality check that runs the byte compare over the *provided*
// token so a short guess can't be distinguished from a wrong-but-same-length
// one by timing.
function constantTimeEquals(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) {
    diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return diff === 0;
}
