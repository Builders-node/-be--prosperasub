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

/**
 * The unit each rail counts in.
 *
 * A $1.00 payout once left as 100 sats — $0.07 — because cents were handed to
 * a mutation whose schema says SatAmount. These are the tests that stop that
 * from being possible again.
 */
describe("BlinkService.sendPayout units", () => {
  const RATE = { realtimePrice: { btcSatPrice: { base: 64130968750, offset: 12 } } };

  function svc(sendResult: any = { status: "SUCCESS" }, rate: any = RATE) {
    const s: any = new (require("./blink.service").BlinkService)({
      get: (k: string) => ({
        BLINK_API_KEY: "k", BLINK_WALLET_ID: "usd-wallet", BLINK_PAYOUTS_ENABLED: "true",
      } as any)[k],
    } as any);
    const calls: any[] = [];
    s.request = jest.fn(async (query: string, vars: any) => {
      calls.push({ query, vars });
      if (query.includes("realtimePrice")) return rate;
      if (query.includes("lnAddressPaymentSend")) return { lnAddressPaymentSend: sendResult };
      return { onChainUsdPaymentSend: sendResult };
    });
    return { s, calls };
  }

  it("converts cents to sats for a Lightning address", async () => {
    const { s, calls } = svc();
    // 100 cents at 0.0641309…c per sat ≈ 1559 sats, not 100.
    const out = await s.sendPayout({
      destination: { kind: "lightning_address", value: "elias@blink.sv" },
      amountCents: 100, memo: "m",
    });
    const send = calls.find((c) => c.query.includes("lnAddressPaymentSend"));
    expect(send.vars.input.amount).toBe(1559);
    expect(out).toMatchObject({ sentAmount: 1559, sentUnit: "sat" });
  });

  it("passes cents straight through on-chain, where the schema wants CentAmount", async () => {
    const { s, calls } = svc();
    const out = await s.sendPayout({
      destination: { kind: "onchain", value: "bc1qar0srrr7xfkvy5l643lydnw9re59gtzzwf5mdq" },
      amountCents: 2500, memo: "m",
    });
    const send = calls.find((c) => c.query.includes("onChainUsdPaymentSend"));
    expect(send.vars.input.amount).toBe(2500);
    expect(out).toMatchObject({ sentAmount: 2500, sentUnit: "cent" });
    expect(calls.some((c) => c.query.includes("realtimePrice"))).toBe(false);
  });

  it("sends nothing when it cannot get a rate", async () => {
    const { s, calls } = svc({ status: "SUCCESS" }, { realtimePrice: null });
    await expect(s.sendPayout({
      destination: { kind: "lightning_address", value: "elias@blink.sv" },
      amountCents: 100, memo: "m",
    })).rejects.toThrow(/Could not price/);
    expect(calls.some((c) => c.query.includes("PaymentSend"))).toBe(false);
  });

  it("sends nothing when the rate is absurd", async () => {
    // base/10^offset here implies roughly $6.41 per BTC.
    const { s, calls } = svc({ status: "SUCCESS" }, {
      realtimePrice: { btcSatPrice: { base: 64130968750, offset: 21 } },
    });
    await expect(s.sendPayout({
      destination: { kind: "lightning_address", value: "elias@blink.sv" },
      amountCents: 100, memo: "m",
    })).rejects.toThrow(/rate looked wrong/);
    expect(calls.some((c) => c.query.includes("PaymentSend"))).toBe(false);
  });
});
