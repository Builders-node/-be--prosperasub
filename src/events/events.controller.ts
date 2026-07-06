import { Controller, ForbiddenException, Get, Post, Req } from "@nestjs/common";
import { ApiExcludeController } from "@nestjs/swagger";
import type { Request } from "express";
import { OutboxDispatcherService } from "./outbox-dispatcher.service";

/**
 * Vercel-cron entrypoint that drains the domain-event outbox. Protected by
 * CRON_SECRET (same convention as the other cron endpoints).
 */
@ApiExcludeController()
@Controller("cron")
export class EventsController {
  constructor(private readonly dispatcher: OutboxDispatcherService) {}

  @Get("dispatch-events")
  dispatchGet(@Req() req: Request) {
    this.assertSecret(req);
    return this.dispatcher.drain();
  }

  @Post("dispatch-events")
  dispatchPost(@Req() req: Request) {
    this.assertSecret(req);
    return this.dispatcher.drain();
  }

  private assertSecret(req: Request) {
    const secret = process.env.CRON_SECRET;
    if (secret) {
      const header = req.headers.authorization || "";
      const provided = header.startsWith("Bearer ") ? header.slice(7) : (req.query.secret as string) || "";
      if (provided !== secret) {
        throw new ForbiddenException("Invalid cron secret.");
      }
    }
  }
}
