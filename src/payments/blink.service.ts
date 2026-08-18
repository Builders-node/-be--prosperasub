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
        // allow 1 sat rounding; underpayment does not count
        const okAmount = !expectedSats || amount >= expectedSats - 1;
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
   *   • It is amount-in-cents, from the USD wallet, both for a Lightning
   *     address and for an on-chain address. No sats arithmetic and no BTC
   *     price lookup sits between the figure an admin approved and the figure
   *     that leaves — a rate that moved between approval and send cannot
   *     change what the provider is paid.
   *
   *   • PENDING is not failure. A Lightning payment can still be routing and
   *     an on-chain one is broadcast but unconfirmed; the caller keeps such a
   *     payout in flight rather than paying it twice.
   */
  async sendPayout(input: {
    destination: { kind: "lightning_address" | "onchain"; value: string };
    amountCents: number;
    memo: string;
  }): Promise<{ status: "SUCCESS" | "PENDING" | "FAILURE" | "ALREADY_PAID"; error: string | null }> {
    if (!Number.isFinite(input.amountCents) || input.amountCents <= 0) {
      throw new ServiceUnavailableException("A payout needs a positive amount.");
    }
    const walletId = this.walletId;
    const amount = Math.round(input.amountCents);

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
        ).then((r) => r.onChainUsdPaymentSend);

    const error = result?.errors?.find((e) => e.message)?.message ?? null;
    const status = (result?.status ?? (error ? "FAILURE" : "PENDING")).toUpperCase();
    const known = ["SUCCESS", "PENDING", "FAILURE", "ALREADY_PAID"].includes(status);
    return {
      status: (known ? status : "FAILURE") as "SUCCESS" | "PENDING" | "FAILURE" | "ALREADY_PAID",
      error,
    };
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
    return ["1", "true", "yes", "on"].includes(flag) && !!this.apiKey && !!this.walletId;
  }

  private async request<T>(query: string, variables: Record<string, unknown>): Promise<T> {
    this.assertConfigured();

    const response = await fetch(this.graphqlUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-API-KEY": this.apiKey
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
