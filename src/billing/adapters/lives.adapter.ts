import { Injectable } from "@nestjs/common";
import { SimpleFiService } from "../../payments/simplefi.service";
import type { PaymentProvider, PaymentVerifyResult } from "../payment-provider.port";

/** Wraps LIVES / Infinita (SimpleFi) behind the payment port. */
@Injectable()
export class LivesAdapter implements PaymentProvider {
  readonly method = "lives" as const;

  constructor(private readonly simplefi: SimpleFiService) {}

  async verify(providerRef: string): Promise<PaymentVerifyResult> {
    const s = await this.simplefi.getPaymentStatus(providerRef);
    return { paid: s.paid, status: s.status, raw: s };
  }
}
