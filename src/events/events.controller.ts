import { Controller, Get, Post, UseGuards } from "@nestjs/common";
import { ApiExcludeController } from "@nestjs/swagger";
import { CronGuard } from "../common/cron.guard";
import { OutboxDispatcherService } from "./outbox-dispatcher.service";

/** Vercel-cron entrypoint that drains the domain-event outbox. */
@ApiExcludeController()
@UseGuards(CronGuard)
@Controller("cron")
export class EventsController {
  constructor(private readonly dispatcher: OutboxDispatcherService) {}

  @Get("dispatch-events")
  dispatchGet() {
    return this.dispatcher.drain();
  }

  @Post("dispatch-events")
  dispatchPost() {
    return this.dispatcher.drain();
  }
}
