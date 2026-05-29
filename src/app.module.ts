import { Module } from "@nestjs/common";
import { ConfigModule } from "@nestjs/config";
import { AdminModule } from "./admin/admin.module";
import { AuthModule } from "./auth/auth.module";
import { CatalogModule } from "./catalog/catalog.module";
import { HealthController } from "./health/health.controller";
import { MailModule } from "./mail/mail.module";
import { PaymentsModule } from "./payments/payments.module";
import { PrismaModule } from "./prisma/prisma.module";

@Module({
  imports: [
    ConfigModule.forRoot({
      envFilePath: [".env"],
      isGlobal: true
    }),
    PrismaModule,
    AuthModule,
    MailModule,
    CatalogModule,
    PaymentsModule,
    AdminModule
  ],
  controllers: [HealthController]
})
export class AppModule {}
