import { Injectable } from "@nestjs/common";
import type { PaymentMethod, PaymentProvider } from "./payment-provider.port";
import { LightningAdapter } from "./adapters/lightning.adapter";
import { OnchainAdapter } from "./adapters/onchain.adapter";
import { PayPalAdapter } from "./adapters/paypal.adapter";

/** Resolves the payment-port adapter for a given method. */
@Injectable()
export class PaymentProviderRegistry {
  private readonly byMethod: Map<PaymentMethod, PaymentProvider>;

  constructor(
    lightning: LightningAdapter,
    onchain: OnchainAdapter,
    paypal: PayPalAdapter,
  ) {
    this.byMethod = new Map<PaymentMethod, PaymentProvider>([
      [lightning.method, lightning],
      [onchain.method, onchain],
      [paypal.method, paypal],
    ]);
  }

  get(method: PaymentMethod): PaymentProvider {
    const provider = this.byMethod.get(method);
    if (!provider) throw new Error(`No payment provider adapter for method '${method}'`);
    return provider;
  }
}
