import { Module } from "@nestjs/common";
import { CatalogService } from "../catalog/catalog.service";
import { NotificationsModule } from "../notifications/notifications.module";
import { BlinkService } from "./blink.service";
import { PayPalService } from "./paypal.service";
import { SubscriptionRenewalService } from "./subscription-renewal.service";
import { PaymentsController, OnchainPaymentsController } from "./payments.controller";
import { BlinkWebhookController } from "./blink-webhook.controller";
import { PayPalPaymentsController } from "./paypal-payments.controller";
import { PublicDataController } from "./public-data.controller";
import { PublicDataService } from "./public-data.service";
import { PublicApiKeyGuard } from "./public-api-key.guard";

@Module({
  imports: [NotificationsModule],
  controllers: [PaymentsController, OnchainPaymentsController, BlinkWebhookController, PayPalPaymentsController, PublicDataController],
  providers: [BlinkService, PayPalService, SubscriptionRenewalService, CatalogService, PublicApiKeyGuard, PublicDataService],
  exports: [BlinkService, PayPalService, SubscriptionRenewalService]
})
export class PaymentsModule {}
