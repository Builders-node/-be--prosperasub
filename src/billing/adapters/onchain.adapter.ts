import { Injectable } from "@nestjs/common";
import { BlinkService } from "../../payments/blink.service";
import type { PaymentProvider, PaymentVerifyResult } from "../payment-provider.port";

/** Wraps Blink on-chain BTC behind the payment port. */
@Injectable()
export class OnchainAdapter implements PaymentProvider {
  readonly method = "onchain" as const;

  constructor(private readonly blink: BlinkService) {}

  async verify(providerRef: string, opts?: Record<string, unknown>): Promise<PaymentVerifyResult> {
    const amountSats = typeof opts?.amountSats === "number" ? opts.amountSats : undefined;
    const s = await this.blink.getOnchainStatus(providerRef, amountSats);
    return { paid: s.paid, status: s.status, raw: s };
  }
}
