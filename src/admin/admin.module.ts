import { Module } from "@nestjs/common";
import { AccountModule } from "../account/account.module";
import { AuthModule } from "../auth/auth.module";
import { CatalogModule } from "../catalog/catalog.module";
import { GoogleCalendarModule } from "../google-calendar/google-calendar.module";
import { MailModule } from "../mail/mail.module";
import { NotificationsModule } from "../notifications/notifications.module";
import { PaymentsModule } from "../payments/payments.module";
import { PrismaModule } from "../prisma/prisma.module";
import { AdminAuthGuard } from "./admin-auth.guard";
import { AdminController } from "./admin.controller";
import { CronController } from "./cron.controller";
import { AdminContentService } from "./admin-content.service";
import { AdminRbacService } from "./admin-rbac.service";
import { AdminService } from "./admin.service";

@Module({
  imports: [AuthModule, CatalogModule, PrismaModule, GoogleCalendarModule, MailModule, NotificationsModule, PaymentsModule, AccountModule],
  controllers: [AdminController, CronController],
  providers: [AdminAuthGuard, AdminRbacService, AdminService, AdminContentService],
  // AdminAuthGuard is used by controllers in OTHER modules (support, …). It
  // injects AdminRbacService, so both have to leave this module or Nest
  // fails to resolve the guard and the whole app refuses to boot — which
  // takes down every route, not just the borrowing one.
  exports: [AdminAuthGuard, AdminRbacService],
})
export class AdminModule {}
