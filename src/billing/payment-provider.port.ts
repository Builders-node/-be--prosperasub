/**
 * Billing domain — the payment-provider PORT (hexagonal architecture).
 * A uniform interface over every payment rail. Adapters (infra) wrap the
 * concrete gateway services; the domain depends only on this contract.
 * Verification is centralized through here now; charge creation routes through
 * it in Phase 1b.
 */

export type PaymentMethod = "lightning" | "onchain" | "lives" | "paypal";

export interface PaymentVerifyResult {
  paid: boolean;
  status: string;
  raw?: unknown;
}

export interface PaymentProvider {
  readonly method: PaymentMethod;
  verify(providerRef: string, opts?: Record<string, unknown>): Promise<PaymentVerifyResult>;
}
