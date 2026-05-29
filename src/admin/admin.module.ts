import { Module } from "@nestjs/common";
import { AuthModule } from "../auth/auth.module";
import { CatalogModule } from "../catalog/catalog.module";
import { GoogleCalendarModule } from "../google-calendar/google-calendar.module";
import { NotificationsModule } from "../notifications/notifications.module";
import { PrismaModule } from "../prisma/prisma.module";
import { AdminAuthGuard } from "./admin-auth.guard";
import { AdminController } from "./admin.controller";
import { AdminService } from "./admin.service";

@Module({
  imports: [AuthModule, CatalogModule, PrismaModule, GoogleCalendarModule, NotificationsModule],
  controllers: [AdminController],
  providers: [AdminAuthGuard, AdminService]
})
export class AdminModule {}
