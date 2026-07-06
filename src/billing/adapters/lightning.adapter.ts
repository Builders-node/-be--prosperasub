import { Injectable } from "@nestjs/common";
import { BlinkService } from "../../payments/blink.service";
import type { PaymentProvider, PaymentVerifyResult } from "../payment-provider.port";

/** Wraps Blink Lightning behind the payment port. */
@Injectable()
export class LightningAdapter implements PaymentProvider {
  readonly method = "lightning" as const;

  constructor(private readonly blink: BlinkService) {}

  async verify(providerRef: string): Promise<PaymentVerifyResult> {
    const s = await this.blink.getPaymentStatus(providerRef);
    return { paid: s.paid, status: s.status, raw: s };
  }
}
