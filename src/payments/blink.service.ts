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
}
