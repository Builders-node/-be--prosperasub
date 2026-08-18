import { CanActivate, ExecutionContext, ForbiddenException, Injectable, Logger } from "@nestjs/common";
import type { Request } from "express";

/**
 * The one check on a cron endpoint.
 *
 * There were four hand-written copies of this — in `admin/cron.controller`,
 * `events/events.controller`, `booking/booking-cron.controller` and
 * `account/reminders.controller` — and they had already drifted: three
 * accepted `?secret=` and threw 403, the fourth accepted only a header and
 * threw 401. A caller that worked against one endpoint could be rejected by
 * the next for reasons nobody had decided on purpose.
 *
 * Accepted, in order: `Authorization: Bearer <secret>`, a bare
 * `Authorization: <secret>` (what the reminders cron has always sent), and
 * `?secret=` for hitting one by hand from a browser.
 *
 * Fail-open when CRON_SECRET is unset is deliberate and inherited: these
 * endpoints are idempotent reconcilers, and a deployment that forgot the
 * variable should still reconcile rather than silently stop taking payments
 * off the pending pile. It logs a warning so "unset" is visible rather than
 * assumed — that was the part all four copies were missing.
 */
@Injectable()
export class CronGuard implements CanActivate {
  private readonly logger = new Logger(CronGuard.name);
  private warned = false;

  canActivate(context: ExecutionContext): boolean {
    const req = context.switchToHttp().getRequest<Request>();
    const expected = process.env.CRON_SECRET;

    if (!expected) {
      if (!this.warned) {
        this.warned = true;
        this.logger.warn("CRON_SECRET is not set — cron endpoints are unauthenticated.");
      }
      return true;
    }

    if (this.provided(req) !== expected) {
      throw new ForbiddenException("Invalid cron secret.");
    }
    return true;
  }

  private provided(req: Request): string {
    const header = req.headers.authorization || "";
    if (header.startsWith("Bearer ")) return header.slice(7);
    if (header) return header;
    const query = req.query?.secret;
    return typeof query === "string" ? query : "";
  }
}
