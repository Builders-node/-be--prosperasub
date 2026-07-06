import { Injectable } from "@nestjs/common";
import { PayPalService } from "../../payments/paypal.service";
import type { PaymentProvider, PaymentVerifyResult } from "../payment-provider.port";

/** Wraps PayPal behind the payment port. verify() captures the order (idempotent). */
@Injectable()
export class PayPalAdapter implements PaymentProvider {
  readonly method = "paypal" as const;

  constructor(private readonly paypal: PayPalService) {}

  async verify(providerRef: string): Promise<PaymentVerifyResult> {
    const s = await this.paypal.captureOrder(providerRef);
    return { paid: s.paid, status: s.status, raw: s };
  }
}
