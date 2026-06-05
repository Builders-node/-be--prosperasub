import { Module } from "@nestjs/common";
import { AccountModule } from "../account/account.module";
import { AuthModule } from "../auth/auth.module";
import { CatalogModule } from "../catalog/catalog.module";
import { GoogleCalendarModule } from "../google-calendar/google-calendar.module";
import { NotificationsModule } from "../notifications/notifications.module";
import { PaymentsModule } from "../payments/payments.module";
import { PrismaModule } from "../prisma/prisma.module";
import { AdminAuthGuard } from "./admin-auth.guard";
import { AdminController } from "./admin.controller";
import { AdminRbacService } from "./admin-rbac.service";
import { AdminService } from "./admin.service";

@Module({
  imports: [AuthModule, CatalogModule, PrismaModule, GoogleCalendarModule, NotificationsModule, PaymentsModule, AccountModule],
  controllers: [AdminController],
  providers: [AdminAuthGuard, AdminRbacService, AdminService],
})
export class AdminModule {}
