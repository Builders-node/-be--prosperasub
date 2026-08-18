import { ConfigService } from "@nestjs/config";
import { ServiceUnavailableException } from "@nestjs/common";
import { BlinkService } from "./blink.service";

const config = (values: Record<string, string | undefined>) =>
  ({
    get: (key: string) => values[key]
  }) as ConfigService;

describe("BlinkService", () => {
  const originalFetch = global.fetch;

  afterEach(() => {
    global.fetch = originalFetch;
    jest.restoreAllMocks();
  });

  it("creates a USD lightning invoice through Blink", async () => {
    const fetchMock = jest.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        data: {
          lnUsdInvoiceCreate: {
            errors: [],
            invoice: {
              paymentHash: "blink-payment-hash",
              paymentRequest: "lnbc1invoice",
              paymentSecret: "secret",
              satoshis: 1234
            }
          }
        }
      })
    });
    global.fetch = fetchMock as unknown as typeof fetch;

    const service = new BlinkService(
      config({
        BLINK_GRAPHQL_URL: "https://api.blink.sv/graphql",
        BLINK_API_KEY: "blink_test_key",
        BLINK_WALLET_ID: "usd-wallet-id"
      })
    );

    const invoice = await service.createUsdInvoice({
      amountCents: 50000,
      memo: "Standard Weekly",
      externalId: "checkout-123"
    });

    expect(invoice).toEqual({
      payment_hash: "blink-payment-hash",
      payment_request: "lnbc1invoice",
      checking_id: "blink-payment-hash",
      provider: "blink",
      amount_sats: 1234,
      status: "pending"
    });
    expect(fetchMock).toHaveBeenCalledWith(
      "https://api.blink.sv/graphql",
      expect.objectContaining({
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-API-KEY": "blink_test_key"
        },
        body: expect.stringContaining("lnUsdInvoiceCreate")
      })
    );

    const body = JSON.parse(fetchMock.mock.calls[0][1].body as string);
    expect(body.variables.input).toMatchObject({
      amount: 50000,
      walletId: "usd-wallet-id",
      memo: "Standard Weekly",
      externalId: "checkout-123",
      expiresIn: 5
    });
  });

  it("sanitizes Blink external ids before sending invoice requests", async () => {
    const fetchMock = jest.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        data: {
          lnUsdInvoiceCreate: {
            errors: [],
            invoice: {
              paymentHash: "blink-payment-hash",
              paymentRequest: "lnbc1invoice",
              satoshis: 1234
            }
          }
        }
      })
    });
    global.fetch = fetchMock as unknown as typeof fetch;

    const service = new BlinkService(
      config({
        BLINK_GRAPHQL_URL: "https://api.blink.sv/graphql",
        BLINK_API_KEY: "blink_test_key",
        BLINK_WALLET_ID: "usd-wallet-id"
      })
    );

    await service.createUsdInvoice({
      amountCents: 50000,
      memo: "Standard Weekly",
      externalId: "plan:standard weekly/50000?customer=frorex.studio@gmail.com"
    });

    const body = JSON.parse(fetchMock.mock.calls[0][1].body as string);
    expect(body.variables.input.externalId).toBe("plan-standard-weekly-50000-customer-frorex-studio-gmail-com");
  });

  it("checks payment status by payment hash", async () => {
    global.fetch = jest.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        data: {
          lnInvoicePaymentStatusByHash: {
            paymentHash: "blink-payment-hash",
            paymentRequest: "lnbc1invoice",
            status: "PAID"
          }
        }
      })
    }) as unknown as typeof fetch;

    const service = new BlinkService(
      config({
        BLINK_GRAPHQL_URL: "https://api.blink.sv/graphql",
        BLINK_API_KEY: "blink_test_key",
        BLINK_WALLET_ID: "usd-wallet-id"
      })
    );

    await expect(service.getPaymentStatus("blink-payment-hash")).resolves.toEqual({
      paid: true,
      payment_hash: "blink-payment-hash",
      payment_request: "lnbc1invoice",
      status: "paid",
      provider: "blink"
    });
  });

  it("fails closed when Blink credentials are missing", async () => {
    const service = new BlinkService(config({}));

    await expect(
      service.createUsdInvoice({ amountCents: 100, memo: "test" })
    ).rejects.toBeInstanceOf(ServiceUnavailableException);
  });
});

/**
 * Which key signs a payment.
 *
 * The checkout key needs Receive and Read; sending needs Write. Keeping one
 * key for both would mean the credential the storefront uses could empty the
 * wallet, so the send path looks for its own first.
 */
describe("BlinkService payout key", () => {
  const svc = (env: Record<string, string | undefined>) =>
    new (require("./blink.service").BlinkService)({ get: (k: string) => env[k] } as any);

  it("is off unless the flag is set, whatever keys exist", () => {
    expect(svc({ BLINK_API_KEY: "receive-key", BLINK_WALLET_ID: "w" }).payoutsEnabled).toBe(false);
  });

  it("is on with the flag and the checkout key, for an account whose single key can write", () => {
    expect(svc({
      BLINK_PAYOUTS_ENABLED: "true", BLINK_API_KEY: "one-key-does-all", BLINK_WALLET_ID: "w",
    }).payoutsEnabled).toBe(true);
  });

  it("prefers the dedicated payout key, so the checkout key never needs Write", () => {
    const s: any = svc({
      BLINK_PAYOUTS_ENABLED: "true", BLINK_API_KEY: "receive-key",
      BLINK_PAYOUT_API_KEY: "write-key", BLINK_WALLET_ID: "w",
    });
    expect(s.payoutApiKey).toBe("write-key");
    expect(s.apiKey).toBe("receive-key");
    expect(s.payoutsEnabled).toBe(true);
  });

  it("stays off when the flag is on but no key can send", () => {
    expect(svc({ BLINK_PAYOUTS_ENABLED: "true", BLINK_WALLET_ID: "w" }).payoutsEnabled).toBe(false);
  });
});
