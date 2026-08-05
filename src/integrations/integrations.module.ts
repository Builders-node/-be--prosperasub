import { Module } from "@nestjs/common";
import { IntegrationsController } from "./integrations.controller";
import { IntegrationsService } from "./integrations.service";
import { BuildersNodeGuard } from "./builders-node.guard";
import { AuthModule } from "../auth/auth.module";
import { GoogleCalendarModule } from "../google-calendar/google-calendar.module";

@Module({
  // GoogleCalendarModule so a partner booking reaches the cleaners' calendar
  // straight away. Without it the row was only flagged `pending` and waited for
  // the daily cron — up to 24h during which nobody was told to show up.
  imports: [AuthModule, GoogleCalendarModule],
  controllers: [IntegrationsController],
  providers: [IntegrationsService, BuildersNodeGuard],
})
export class IntegrationsModule {}
