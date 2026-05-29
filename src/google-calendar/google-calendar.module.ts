import { Module } from "@nestjs/common";
import { PrismaModule } from "../prisma/prisma.module";
import { CleaningCalendarSyncService } from "./cleaning-calendar-sync.service";
import { GoogleCalendarService } from "./google-calendar.service";

@Module({
  imports: [PrismaModule],
  providers: [GoogleCalendarService, CleaningCalendarSyncService],
  exports: [GoogleCalendarService, CleaningCalendarSyncService],
})
export class GoogleCalendarModule {}
