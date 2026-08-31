import { Injectable, ServiceUnavailableException } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";

type CreateUsdInvoiceInput = {
  amountCents: number;
  memo: string;
  externalId?: string;
};

type BlinkGraphQLError = {
  message?: string;
};

type BlinkInvoice = {
  paymentHash?: string;
  paymentRequest?: string;
  paymentSecret?: string;
  satoshis?: number;
};

@Injectable()
export class BlinkService {
  constructor(private readonly config: ConfigService) {}

  async createUsdInvoice(input: CreateUsdInvoiceInput) {
    const result = await this.request<{
      lnUsdInvoiceCreate?: {
        errors?: BlinkGraphQLError[];
        invoice?: BlinkInvoice;
      };
    }>(
      `
        mutation CreateUsdInvoice($input: LnUsdInvoiceCreateInput!) {
          lnUsdInvoiceCreate(input: $input) {
            errors {
              message
            }
            invoice {
              paymentHash
              paymentRequest
              paymentSecret
              satoshis
            }
          }
        }
      `,
      {
        input: {
          amount: input.amountCents,
          walletId: this.walletId,
          memo: input.memo,
          externalId: this.safeExternalId(input.externalId),
          expiresIn: 5
        }
      }
    );

    const payload = result.lnUsdInvoiceCreate;
    const error = payload?.errors?.find((item) => item.message)?.message;
    if (error) {
      throw new ServiceUnavailableException(error);
    }

    const invoice = payload?.invoice;
    if (!invoice?.paymentHash || !invoice.paymentRequest) {
      throw new ServiceUnavailableException("Blink did not return a Lightning invoice.");
    }

    return {
      payment_hash: invoice.paymentHash,
      payment_request: invoice.paymentRequest,
      checking_id: invoice.paymentHash,
      provider: "blink",
      amount_sats: invoice.satoshis,
      status: "pending"
    };
  }

  async getPaymentStatus(paymentHash: string) {
    const result = await this.request<{
      lnInvoicePaymentStatusByHash?: {
        paymentHash?: string;
        paymentRequest?: string;
        status?: string;
      };
    }>(
      `
        query InvoiceStatus($input: LnInvoicePaymentStatusByHashInput!) {
          lnInvoicePaymentStatusByHash(input: $input) {
            paymentHash
            paymentRequest
            status
          }
        }
      `,
      {
        input: {
          paymentHash
        }
      }
    );

    const status = result.lnInvoicePaymentStatusByHash?.status ?? "PENDING";
    const paid = ["PAID", "SETTLED"].includes(status.toUpperCase());

    return {
      paid,
      payment_hash: result.lnInvoicePaymentStatusByHash?.paymentHash ?? paymentHash,
      payment_request: result.lnInvoicePaymentStatusByHash?.paymentRequest,
      status: paid ? "paid" : status.toLowerCase(),
      provider: "blink"
    };
  }

  /** Create an on-chain receive address on the Blink BTC wallet. */
  async createOnchainAddress(input: { amountSats?: number; memo?: string }) {
    const walletId = await this.resolveBtcWalletId();

    const result = await this.request<{
      onChainAddressCreate?: {
        errors?: BlinkGraphQLError[];
        address?: string;
      };
    }>(
      `
        mutation OnChainAddressCreate($input: OnChainAddressCreateInput!) {
          onChainAddressCreate(input: $input) {
            errors { message }
            address
          }
        }
      `,
      { input: { walletId } }
    );

    const payload = result.onChainAddressCreate;
    const error = payload?.errors?.find((item) => item.message)?.message;
    if (error) {
      throw new ServiceUnavailableException(error);
    }

    const address = payload?.address;
    if (!address) {
      throw new ServiceUnavailableException("Blink did not return a Bitcoin address.");
    }

    return {
      address,
      amount_sats: input.amountSats,
      provider: "blink",
      status: "pending"
    };
  }

  /**
   * Check whether an on-chain address has received the expected amount.
   * Treats both PENDING (mempool/0-conf) and SUCCESS as paid, per product decision.
   */
  async getOnchainStatus(address: string, expectedSats?: number) {
    const result = await this.request<{
      me?: {
        defaultAccount?: {
          wallets?: Array<{
            walletCurrency?: string;
            transactions?: {
              edges?: Array<{
                node?: {
                  settlementAmount?: number;
                  status?: string;
                  initiationVia?: { address?: string };
                };
              }>;
            };
          }>;
        };
      };
    }>(
      `
        query Me {
          me {
            defaultAccount {
              wallets {
                walletCurrency
                transactions(first: 25) {
                  edges {
                    node {
                      settlementAmount
                      status
                      initiationVia {
                        ... on InitiationViaOnChain { address }
                      }
                    }
                  }
                }
              }
            }
          }
        }
      `,
      {}
    );

    const wallets = result.me?.defaultAccount?.wallets ?? [];
    let paid = false;
    for (const wallet of wallets) {
      for (const edge of wallet.transactions?.edges ?? []) {
        const node = edge.node;
        if (!node || node.initiationVia?.address !== address) continue;
        const amount = Number(node.settlementAmount ?? 0);
        const status = (node.status ?? "").toUpperCase();
        const okStatus = status === "SUCCESS" || status === "PENDING";
        // A quoted on-chain amount is almost never paid to the satoshi: the
        // sender's wallet deducts the mining fee, and BTC/USD drifts during the
        // confirmation window — so a legit payment routinely lands a little
        // short (Jason paid 277,936 of a 280,436-sat quote, 0.9% under, and sat
        // pending forever). Accept a small shortfall — 3% or 2,500 sats,
        // whichever is larger — which still blocks the "send 100 sats for a
        // $500 plan" underpayment the guard exists to stop.
        const tolerance = expectedSats ? Math.max(Math.round(expectedSats * 0.03), 2500) : 0;
        const okAmount = !expectedSats || amount >= expectedSats - tolerance;
        if (okStatus && amount > 0 && okAmount) {
          paid = true;
          break;
        }
      }
      if (paid) break;
    }

    return { paid, address, provider: "blink", status: paid ? "paid" : "pending" };
  }

  /**
   * Send money out of the platform's USD wallet.
   *
   * Everything else in this service RECEIVES; this is the one method that
   * moves funds the other way, and it is only ever reached from an admin
   * pressing Send on an approved payout. Two consequences worth stating:
   *
   *   • **The two rails count in different units, and Blink's schema is the
   *     authority on which.** `onChainUsdPaymentSend.amount` is a CentAmount,
   *     so on-chain takes the figure as-is. `lnAddressPaymentSend.amount` is a
   *     **SatAmount** — passing cents there sent 100 sats for a $1.00 payout
   *     ($0.07 arrived) because the number was read as sats. Lightning is
   *     therefore priced through `satsForCents` immediately before sending.
   *
   *   • PENDING is not failure. A Lightning payment can still be routing and
   *     an on-chain one is broadcast but unconfirmed; the caller keeps such a
   *     payout in flight rather than paying it twice.
   */
  async sendPayout(input: {
    destination: { kind: "lightning_address" | "onchain"; value: string };
    amountCents: number;
    memo: string;
  }): Promise<{
    status: "SUCCESS" | "PENDING" | "FAILURE" | "ALREADY_PAID";
    error: string | null;
    /** What actually left, in the unit Blink counted it in. */
    sentAmount: number;
    sentUnit: "sat" | "cent";
  }> {
    if (!Number.isFinite(input.amountCents) || input.amountCents <= 0) {
      throw new ServiceUnavailableException("A payout needs a positive amount.");
    }
    const walletId = this.walletId;
    const cents = Math.round(input.amountCents);
    // Sent with the payout key, not the checkout one. See `payoutApiKey`.
    const key = this.payoutApiKey;

    // Lightning is denominated in sats by the schema; on-chain USD in cents.
    const amount = input.destination.kind === "lightning_address"
      ? await this.satsForCents(cents)
      : cents;

    const result = input.destination.kind === "lightning_address"
      ? await this.request<{ lnAddressPaymentSend?: { status?: string; errors?: BlinkGraphQLError[] } }>(
          `
            mutation SendToLnAddress($input: LnAddressPaymentSendInput!) {
              lnAddressPaymentSend(input: $input) {
                status
                errors { message }
              }
            }
          `,
          { input: { walletId, lnAddress: input.destination.value, amount } },
          key,
        ).then((r) => r.lnAddressPaymentSend)
      : await this.request<{ onChainUsdPaymentSend?: { status?: string; errors?: BlinkGraphQLError[] } }>(
          `
            mutation SendOnChain($input: OnChainUsdPaymentSendInput!) {
              onChainUsdPaymentSend(input: $input) {
                status
                errors { message }
              }
            }
          `,
          { input: { walletId, address: input.destination.value, amount, memo: input.memo } },
          key,
        ).then((r) => r.onChainUsdPaymentSend);

    const error = result?.errors?.find((e) => e.message)?.message ?? null;
    const status = (result?.status ?? (error ? "FAILURE" : "PENDING")).toUpperCase();
    const known = ["SUCCESS", "PENDING", "FAILURE", "ALREADY_PAID"].includes(status);
    return {
      status: (known ? status : "FAILURE") as "SUCCESS" | "PENDING" | "FAILURE" | "ALREADY_PAID",
      error,
      sentAmount: amount,
      sentUnit: input.destination.kind === "lightning_address" ? "sat" : "cent",
    };
  }

  /**
   * USD cents as sats, at Blink's own rate.
   *
   * `lnAddressPaymentSend` takes a SatAmount, so a payout figure that lives in
   * cents everywhere else has to be converted at the last moment — and by the
   * same house that is about to move the money, so our number and theirs
   * cannot disagree.
   *
   * Unlike the balance check, this **fails closed**. A payment we could not
   * price is exactly the failure that already happened once: sending a number
   * whose unit nobody had established. Better a refusal than a payout at a
   * rate nobody chose.
   */
  private async satsForCents(cents: number): Promise<number> {
    const result = await this.request<{
      realtimePrice?: { btcSatPrice?: { base?: number; offset?: number } };
    }>(
      `
        query PayoutRate($currency: DisplayCurrency) {
          realtimePrice(currency: $currency) {
            btcSatPrice { base offset }
          }
        }
      `,
      { currency: "USD" },
      this.payoutApiKey,
    );

    const base = Number(result.realtimePrice?.btcSatPrice?.base);
    const offset = Number(result.realtimePrice?.btcSatPrice?.offset);
    if (!Number.isFinite(base) || base <= 0 || !Number.isFinite(offset) || offset < 0) {
      throw new ServiceUnavailableException("Could not price this payout — nothing was sent.");
    }

    // `btcSatPrice` is what one sat costs in cents, scaled by 10^offset.
    const centsPerSat = base / 10 ** offset;
    const sats = Math.round(cents / centsPerSat);

    // A price feed that has gone strange must not become a payout a hundred
    // times too big. One BTC is 100,000,000 sats; this brackets the implied
    // price to somewhere between $1k and $10M and refuses outside it.
    const impliedBtcUsd = (centsPerSat * 100_000_000) / 100;
    if (!Number.isFinite(sats) || sats <= 0 || impliedBtcUsd < 1_000 || impliedBtcUsd > 10_000_000) {
      throw new ServiceUnavailableException("The exchange rate looked wrong — nothing was sent.");
    }
    return sats;
  }

  /**
   * What the USD wallet actually holds, in cents.
   *
   * Payouts are drawn from this wallet and nothing else tops it up
   * automatically: Lightning receipts land here, but on-chain ones go to the
   * BTC wallet, so it can run dry while the platform as a whole is solvent.
   * Checking first turns "your payment failed" — after the provider pressed a
   * button that says it cannot be undone — into "not right now".
   *
   * `null` means we could not find out, which is deliberately different from
   * zero: a transient error reading the balance must not hold up money that
   * would have sent perfectly well.
   */
  async usdBalanceCents(): Promise<number | null> {
    try {
      const result = await this.request<{
        me?: { defaultAccount?: { wallets?: Array<{ id?: string; walletCurrency?: string; balance?: number }> } };
      }>(
        `
          query WalletBalances {
            me {
              defaultAccount {
                wallets { id walletCurrency balance }
              }
            }
          }
        `,
        {},
        this.payoutApiKey,
      );
      const wallets = result.me?.defaultAccount?.wallets ?? [];
      // By id first — that is the wallet payouts are actually drawn from —
      // then by currency for an account whose id we were not given.
      const wallet = wallets.find((w) => w.id === this.walletId)
        ?? wallets.find((w) => (w.walletCurrency ?? "").toUpperCase() === "USD");
      const balance = Number(wallet?.balance);
      return Number.isFinite(balance) ? Math.round(balance) : null;
    } catch {
      return null;
    }
  }

  /**
   * Whether the platform is set up to send, as opposed to only receive.
   *
   * Paying out needs an API key with write scope, which the receive-only key
   * does not have, so this is a separate switch: with it off the admin panel
   * keeps the manual "mark as paid" it has always had and never offers a
   * button that would fail at the wallet.
   */
  get payoutsEnabled(): boolean {
    const flag = String(this.config.get<string>("BLINK_PAYOUTS_ENABLED") ?? "").toLowerCase();
    return ["1", "true", "yes", "on"].includes(flag) && !!this.payoutApiKey && !!this.walletId;
  }

  /**
   * The key that may spend, kept apart from the key that may receive.
   *
   * Blink scopes a key at creation — Read, Write, Receive — and one key has
   * always done everything here: `Receive` to raise a checkout invoice, `Read`
   * to poll it. Adding `Write` to that key would make the credential the
   * storefront uses capable of emptying the wallet, and swapping it for a
   * write-only one would break checkout instead.
   *
   * So sending looks for `BLINK_PAYOUT_API_KEY` first. Set that to a Write key
   * and the checkout key never changes; leave it unset and the single key is
   * used, which is only sensible if it already carries Write.
   */
  private get payoutApiKey(): string {
    return this.config.get<string>("BLINK_PAYOUT_API_KEY") || this.apiKey;
  }

  private async request<T>(query: string, variables: Record<string, unknown>, apiKey?: string): Promise<T> {
    this.assertConfigured();

    const response = await fetch(this.graphqlUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-API-KEY": apiKey || this.apiKey
      },
      body: JSON.stringify({ query, variables })
    });

    if (!response.ok) {
      throw new ServiceUnavailableException(`Blink returned HTTP ${response.status}.`);
    }

    const payload = await response.json() as {
      data?: T;
      errors?: BlinkGraphQLError[];
    };
    const error = payload.errors?.find((item) => item.message)?.message;
    if (error) {
      throw new ServiceUnavailableException(error);
    }

    if (!payload.data) {
      throw new ServiceUnavailableException("Blink did not return payment data.");
    }

    return payload.data;
  }

  private assertConfigured() {
    if (!this.graphqlUrl || !this.apiKey || !this.walletId) {
      throw new ServiceUnavailableException("Blink payments are not configured.");
    }
  }

  private safeExternalId(externalId?: string) {
    if (!externalId) {
      return undefined;
    }

    const sanitized = externalId
      .replace(/[^a-zA-Z0-9_-]/g, "-")
      .replace(/-+/g, "-")
      .replace(/^[-_]+|[-_]+$/g, "")
      .slice(0, 100);

    return sanitized || undefined;
  }

  private get graphqlUrl() {
    return this.config.get<string>("BLINK_GRAPHQL_URL") || "https://api.blink.sv/graphql";
  }

  private get apiKey() {
    return this.config.get<string>("BLINK_API_KEY") || "";
  }

  private get walletId() {
    return this.config.get<string>("BLINK_WALLET_ID") || "";
  }

  private cachedBtcWalletId: string | null = null;

  /**
   * Resolve the Blink BTC wallet id. Uses BLINK_BTC_WALLET_ID if set, otherwise
   * auto-discovers it from the account (the same API key used for Lightning).
   */
  private async resolveBtcWalletId(): Promise<string> {
    const configured = this.config.get<string>("BLINK_BTC_WALLET_ID");
    if (configured) return configured;
    if (this.cachedBtcWalletId) return this.cachedBtcWalletId;

    const result = await this.request<{
      me?: {
        defaultAccount?: {
          wallets?: Array<{ id?: string; walletCurrency?: string }>;
        };
      };
    }>(
      `
        query Me {
          me {
            defaultAccount {
              wallets { id walletCurrency }
            }
          }
        }
      `,
      {}
    );

    const wallets = result.me?.defaultAccount?.wallets ?? [];
    const btc = wallets.find((w) => (w.walletCurrency ?? "").toUpperCase() === "BTC");
    if (!btc?.id) {
      throw new ServiceUnavailableException("No BTC wallet was found on this Blink account.");
    }
    this.cachedBtcWalletId = btc.id;
    return btc.id;
  }
}
