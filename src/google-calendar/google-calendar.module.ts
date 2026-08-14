import { Module } from "@nestjs/common";
import { PrismaModule } from "../prisma/prisma.module";
import { CleaningCalendarSyncService } from "./cleaning-calendar-sync.service";
import { GoogleCalendarService } from "./google-calendar.service";
import { BeachCourtCalendarSyncService } from "./beach-court-calendar-sync.service";
import { ProviderCalendarService } from "./provider-calendar.service";

@Module({
  imports: [PrismaModule],
  providers: [GoogleCalendarService, CleaningCalendarSyncService, BeachCourtCalendarSyncService, ProviderCalendarService],
  exports: [GoogleCalendarService, CleaningCalendarSyncService, BeachCourtCalendarSyncService, ProviderCalendarService],
})
export class GoogleCalendarModule {}
