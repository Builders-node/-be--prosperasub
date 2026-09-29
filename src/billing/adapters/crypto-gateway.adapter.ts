import { Injectable } from "@nestjs/common";
import { CryptoGatewayService } from "../../payments/crypto-gateway/crypto-gateway.service";
import type { PaymentProvider, PaymentVerifyResult } from "../payment-provider.port";

/** Wraps the multi-coin crypto gateway (NOWPayments, …) behind the payment port. */
@Injectable()
export class CryptoGatewayAdapter implements PaymentProvider {
  readonly method = "crypto_gateway" as const;

  constructor(private readonly crypto: CryptoGatewayService) {}

  async verify(providerRef: string): Promise<PaymentVerifyResult> {
    const s = await this.crypto.verify(providerRef);
    return { paid: s.paid, status: s.rawStatus, raw: s };
  }
}
