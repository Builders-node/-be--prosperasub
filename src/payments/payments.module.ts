import { Module } from "@nestjs/common";
import { CatalogService } from "../catalog/catalog.service";
import { NotificationsModule } from "../notifications/notifications.module";
import { BlinkService } from "./blink.service";
import { SimpleFiService } from "./simplefi.service";
import { PayPalService } from "./paypal.service";
import { PaymentsController, OnchainPaymentsController } from "./payments.controller";
import { SimpleFiPaymentsController } from "./simplefi-payments.controller";
import { PayPalPaymentsController } from "./paypal-payments.controller";
import { PublicPaymentsController } from "./public-payments.controller";
import { PublicDataController } from "./public-data.controller";
import { PublicDataService } from "./public-data.service";
import { PublicApiKeyGuard } from "./public-api-key.guard";

@Module({
  imports: [NotificationsModule],
  controllers: [PaymentsController, OnchainPaymentsController, SimpleFiPaymentsController, PayPalPaymentsController, PublicPaymentsController, PublicDataController],
  providers: [BlinkService, SimpleFiService, PayPalService, CatalogService, PublicApiKeyGuard, PublicDataService],
  exports: [BlinkService, SimpleFiService, PayPalService]
})
export class PaymentsModule {}
