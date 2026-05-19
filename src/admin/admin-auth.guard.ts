import { CanActivate, ExecutionContext, ForbiddenException, Injectable, UnauthorizedException } from "@nestjs/common";
import type { Request } from "express";
import { SessionService } from "../auth/session.service";

export interface AdminRequest extends Request {
  adminUser?: {
    id: string;
    roles: string[];
  };
}

@Injectable()
export class AdminAuthGuard implements CanActivate {
  constructor(private readonly sessions: SessionService) {}

  canActivate(context: ExecutionContext): boolean {
    const request = context.switchToHttp().getRequest<AdminRequest>();
    const token = this.readBearerToken(request);

    if (!token) {
      throw new UnauthorizedException("Admin access token is required");
    }

    const payload = this.sessions.verifyAccessToken(token);
    const roles = payload.roles ?? [];

    if (!roles.includes("SUPER_ADMIN")) {
      throw new ForbiddenException("Super admin access is required");
    }

    request.adminUser = {
      id: payload.sub,
      roles,
    };

    return true;
  }

  private readBearerToken(request: Request): string | null {
    const header = request.headers.authorization;
    if (!header) return null;
    const [scheme, token] = header.split(" ");
    if (scheme?.toLowerCase() !== "bearer" || !token) return null;
    return token;
  }
}
