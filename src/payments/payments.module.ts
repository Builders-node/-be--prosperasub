import { Module } from "@nestjs/common";
import { CatalogService } from "../catalog/catalog.service";
import { NotificationsModule } from "../notifications/notifications.module";
import { BlinkService } from "./blink.service";
import { PaymentsController } from "./payments.controller";

@Module({
  imports: [NotificationsModule],
  controllers: [PaymentsController],
  providers: [BlinkService, CatalogService]
})
export class PaymentsModule {}
