/**
 * A crypto payment GATEWAY — one integration that accepts many coins
 * (USDT/USDC on several chains, ETH, SOL, LTC, …) and tells us when one of
 * them paid a USD-priced order.
 *
 * Bitcoin does not go through here: Lightning and on-chain BTC are Blink's,
 * and stay so. This is for everything else.
 *
 * The contract is deliberately the shape every such gateway shares
 * (NOWPayments, CoinGate, Cryptomus, Plisio, a self-hosted BTCPay): price in
 * USD, customer picks a coin, gateway returns an address + amount, gateway
 * reports a status. Swapping providers means writing one more class that
 * implements this, and nothing above it changes — the stored
 * `payment_method` stays `crypto_gateway` whichever gateway took the money;
 * the concrete one is on the checkout session and the ledger row.
 */

/** What the platform stores in `payment_method` for every gateway payment. */
export const CRYPTO_GATEWAY_METHOD = "crypto_gateway" as const;

/**
 * The only states the rest of the platform reasons about.
 * - `paid`     — the money is ours; activate the order.
 * - `partial`  — something arrived, but less than asked. NOT paid: an
 *                underpayment must never activate a plan.
 * - `waiting` / `confirming` — keep polling.
 * - `expired` / `failed` / `refunded` — terminal, not paid.
 */
export type CryptoPaymentState =
  | "waiting"
  | "confirming"
  | "paid"
  | "partial"
  | "expired"
  | "failed"
  | "refunded";

export interface CryptoCurrency {
  /** Gateway ticker, lowercase, passed back verbatim on create (`usdttrc20`). */
  code: string;
}

export interface CreateCryptoPaymentInput {
  /** Base price + surcharge, USD cents — the figure the customer is charged. */
  amountCents: number;
  /** Ticker from `listCurrencies()`. */
  payCurrency: string;
  /** Our id for the order (appears in the gateway dashboard). */
  orderId: string;
  description: string;
  /** Where the gateway POSTs status changes. */
  callbackUrl: string;
}

export interface CryptoPayment {
  /** The gateway's id — stored as `payment_reference`. */
  paymentId: string;
  state: CryptoPaymentState;
  /** Raw gateway status, for logs and the admin. */
  rawStatus: string;
  payAddress: string | null;
  /** Memo / destination tag some chains need (TON, XRP, XLM…). Without it the
   *  money arrives at the gateway but cannot be matched to the order. */
  payExtraId: string | null;
  /** Amount of `payCurrency` the customer must send, as a decimal string —
   *  never a float; 18-decimal tokens do not survive a JS number. */
  payAmount: string | null;
  payCurrency: string | null;
  /** What the gateway believes the order is worth, USD cents. */
  priceCents: number | null;
  expiresAt: string | null;
}

export interface CryptoGateway {
  /** Stable key — used as the checkout-session provider and the ledger provider. */
  readonly id: string;
  isConfigured(): boolean;
  listCurrencies(): Promise<CryptoCurrency[]>;
  createPayment(input: CreateCryptoPaymentInput): Promise<CryptoPayment>;
  getPayment(paymentId: string): Promise<CryptoPayment>;
  /**
   * Is this callback really from the gateway? A `false` does not mean the
   * payment is unpaid — the controller still re-asks the gateway — it means
   * the body is not trusted even as a hint.
   */
  verifyCallback(body: unknown, headers: Record<string, string | string[] | undefined>): boolean;
  /** Which payment a callback is about, if the body says. */
  paymentIdFromCallback(body: unknown): string | null;
}

/** Nest injection token for the active gateway (null when none configured). */
export const CRYPTO_GATEWAY = Symbol("CRYPTO_GATEWAY");
