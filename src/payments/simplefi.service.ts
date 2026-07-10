import { Injectable, ServiceUnavailableException } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";

const SIMPLEFI_API = "https://api.simplefi.tech";
// Fallback used only when SIMPLEFI_MERCHANT_ID is missing — the ID that
// SimpleFi routes funds to must match the wallet you want credited. If yours
// doesn't match this constant, override via env var. See merchantId() below.
const MERCHANT_ID_FALLBACK = "6a2b674f53d0c31cce8c7557";

type CreateInvoiceInput = {
  amountCents: number;
  description: string;
  reference?: Record<string, unknown>;
};

@Injectable()
export class SimpleFiService {
  constructor(private readonly config: ConfigService) {}

  async createInvoice(input: CreateInvoiceInput) {
    this.assertConfigured();

    const payload = {
      amount: input.amountCents / 100,
      currency: "USD",
      merchant_id: this.merchantId(),
      reference: {
        description: input.description,
        ...(input.reference || {}),
      },
    };

    const res = await fetch(`${SIMPLEFI_API}/payment_requests`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${this.apiToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(payload),
    });

    if (!res.ok) {
      const errorText = await res.text();
      throw new ServiceUnavailableException(`SimpleFi returned HTTP ${res.status}: ${errorText}`);
    }

    const data = await res.json();
    const paymentId = data.id || data._id;
    const checkoutUrl = data.checkout_v2_url || data.checkout_url;

    if (!paymentId || !checkoutUrl) {
      throw new ServiceUnavailableException("SimpleFi did not return a valid payment request.");
    }

    return {
      payment_id: paymentId,
      checkout_url: checkoutUrl,
      status: data.status || "pending",
      provider: "simplefi",
      destination_address: data.destination_address || data.wallet_address || data.recipient || null,
      token_mint: data.token_mint || data.mint_address || data.token_address || null,
      token_amount: data.token_amount || data.amount_token || null,
      memo: data.memo || data.reference_id || paymentId,
      amount_usd: input.amountCents / 100,
    };
  }

  /** Flexible payment-request creation for the public API (currency, coins, reference passthrough). */
  async createPayment(input: {
    amount: number;
    currency?: string;
    description?: string;
    reference?: Record<string, unknown>;
    coins?: Array<{ chain_id: number; ticker: string }>;
    cardPayment?: boolean;
    notificationUrl?: string;
  }) {
    this.assertConfigured();
    if (!input.amount || input.amount <= 0) {
      throw new ServiceUnavailableException("amount must be greater than 0.");
    }

    const payload: Record<string, unknown> = {
      amount: input.amount,
      currency: input.currency || "USD",
      card_payment: input.cardPayment ?? false,
      merchant_id: this.merchantId(),
      reference: {
        ...(input.description ? { description: input.description } : {}),
        ...(input.reference || {}),
      },
    };
    if (input.coins?.length) payload.coins = input.coins;
    if (input.notificationUrl) payload.notification_url = input.notificationUrl;

    const res = await fetch(`${SIMPLEFI_API}/payment_requests`, {
      method: "POST",
      headers: { Authorization: `Bearer ${this.apiToken}`, "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    if (!res.ok) {
      const errorText = await res.text();
      throw new ServiceUnavailableException(`SimpleFi returned HTTP ${res.status}: ${errorText}`);
    }
    const data = await res.json();
    const paymentId = data.id || data._id;
    const checkoutUrl = data.checkout_v2_url || data.checkout_url;
    if (!paymentId || !checkoutUrl) {
      throw new ServiceUnavailableException("SimpleFi did not return a valid payment request.");
    }
    return {
      payment_id: paymentId,
      checkout_url: checkoutUrl,
      status: data.status || "pending",
      amount: input.amount,
      currency: input.currency || "USD",
      reference: data.reference ?? input.reference ?? null,
      transactions: data.transactions ?? [],
    };
  }

  async getPaymentStatus(paymentId: string) {
    this.assertConfigured();

    const res = await fetch(`${SIMPLEFI_API}/payment_requests/${paymentId}`, {
      method: "GET",
      headers: {
        Authorization: `Bearer ${this.apiToken}`,
      },
    });

    if (!res.ok) {
      throw new ServiceUnavailableException(`SimpleFi status check returned HTTP ${res.status}.`);
    }

    const data = await res.json();
    const status = data.status || "pending";
    const paid = status === "approved" || (status === "expired" && data.status_detail === "correct");

    return {
      paid,
      payment_id: paymentId,
      status: paid ? "paid" : status,
      provider: "simplefi",
    };
  }

  private assertConfigured() {
    if (!this.apiToken) {
      throw new ServiceUnavailableException("Infinita payments are not configured.");
    }
  }

  private get apiToken() {
    return this.config.get<string>("SIMPLEFI_API_TOKEN") || "";
  }

  /** SimpleFi merchant id — determines which wallet receives funds. Set
   *  `SIMPLEFI_MERCHANT_ID` in env to override the platform default. */
  private merchantId(): string {
    const fromEnv = this.config.get<string>("SIMPLEFI_MERCHANT_ID");
    if (fromEnv && fromEnv.trim()) return fromEnv.trim();
    // eslint-disable-next-line no-console
    console.warn(
      `[SimpleFi] SIMPLEFI_MERCHANT_ID is not set. Falling back to hardcoded ID (${MERCHANT_ID_FALLBACK}). ` +
      `Funds will route to whichever wallet owns that merchant. Set SIMPLEFI_MERCHANT_ID in env to your own.`,
    );
    return MERCHANT_ID_FALLBACK;
  }
}
