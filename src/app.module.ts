import { Module } from "@nestjs/common";
import { ConfigModule } from "@nestjs/config";
import { AccountModule } from "./account/account.module";
import { AdminModule } from "./admin/admin.module";
import { AuthModule } from "./auth/auth.module";
import { CatalogModule } from "./catalog/catalog.module";
import { HealthController } from "./health/health.controller";
import { MailModule } from "./mail/mail.module";
import { PaymentsModule } from "./payments/payments.module";
import { PrismaModule } from "./prisma/prisma.module";
import { VerifyModule } from "./verify/verify.module";
import { FoodModule } from "./food/food.module";
import { EventsModule } from "./events/events.module";
import { BillingModule } from "./billing/billing.module";
import { MembershipModule } from "./membership/membership.module";
import { ResourceModule } from "./resource/resource.module";
import { BookingModule } from "./booking/booking.module";
import { OrderModule } from "./order/order.module";
import { AnalyticsModule } from "./analytics/analytics.module";
import { NotificationEventsModule } from "./notification/notification-events.module";
import { IntegrationsModule } from "./integrations/integrations.module";
import { LeadconnectorModule } from "./integrations/leadconnector/leadconnector.module";

@Module({
  imports: [
    ConfigModule.forRoot({
      envFilePath: [".env"],
      isGlobal: true
    }),
    PrismaModule,
    EventsModule,
    BillingModule,
    MembershipModule,
    ResourceModule,
    BookingModule,
    OrderModule,
    AnalyticsModule,
    NotificationEventsModule,
    AuthModule,
    MailModule,
    CatalogModule,
    PaymentsModule,
    AdminModule,
    AccountModule,
    VerifyModule,
    FoodModule,
    IntegrationsModule,
    LeadconnectorModule,
  ],
  controllers: [HealthController]
})
export class AppModule {}
