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
import { PaymentSettlementService } from "./payment-settlement.service";
import { CryptoGatewayService } from "./crypto-gateway/crypto-gateway.service";
import { CryptoPaymentsController, CryptoWebhookController } from "./crypto-gateway/crypto-payments.controller";

@Module({
  imports: [NotificationsModule],
  controllers: [PaymentsController, OnchainPaymentsController, BlinkWebhookController, PayPalPaymentsController, PublicDataController, CryptoPaymentsController, CryptoWebhookController],
  providers: [BlinkService, PayPalService, SubscriptionRenewalService, CatalogService, PublicApiKeyGuard, PublicDataService, PaymentSettlementService, CryptoGatewayService],
  exports: [BlinkService, PayPalService, SubscriptionRenewalService, PaymentSettlementService, CryptoGatewayService]
})
export class PaymentsModule {}
