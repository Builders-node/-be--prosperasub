import { Global, Module } from "@nestjs/common";
import { PaymentsModule } from "../payments/payments.module";
import { BillingService } from "./billing.service";
import { PaymentProviderRegistry } from "./payment-provider.registry";
import { LightningAdapter } from "./adapters/lightning.adapter";
import { OnchainAdapter } from "./adapters/onchain.adapter";
import { PayPalAdapter } from "./adapters/paypal.adapter";

/**
 * Billing domain (Phase 1). Global so any confirmation path can inject
 * `BillingService` (the single place that records payments + emits billing
 * events). Imports PaymentsModule for the concrete gateway services that the
 * port adapters wrap — Payments never imports Billing back (Billing is global),
 * so there is no module cycle.
 */
@Global()
@Module({
  imports: [PaymentsModule],
  providers: [
    BillingService,
    PaymentProviderRegistry,
    LightningAdapter,
    OnchainAdapter,
    PayPalAdapter,
  ],
  exports: [BillingService, PaymentProviderRegistry],
})
export class BillingModule {}
