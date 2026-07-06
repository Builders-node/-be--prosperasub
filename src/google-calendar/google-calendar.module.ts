import { Module } from "@nestjs/common";
import { PrismaModule } from "../prisma/prisma.module";
import { CleaningCalendarSyncService } from "./cleaning-calendar-sync.service";
import { GoogleCalendarService } from "./google-calendar.service";
import { BeachCourtCalendarSyncService } from "./beach-court-calendar-sync.service";

@Module({
  imports: [PrismaModule],
  providers: [GoogleCalendarService, CleaningCalendarSyncService, BeachCourtCalendarSyncService],
  exports: [GoogleCalendarService, CleaningCalendarSyncService, BeachCourtCalendarSyncService],
})
export class GoogleCalendarModule {}
