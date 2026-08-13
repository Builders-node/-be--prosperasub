import { extractPaymentHints, isPaymentHash } from "./blink-webhook.controller";

/**
 * The webhook makes exactly one guess — what in Blink's payload identifies the
 * payment. Everything after that is verified against Blink itself, so this is
 * the only part worth pinning down: it must find a reference in a plausible
 * payload, and must not mistake prose for one.
 */
describe("extractPaymentHints", () => {
  const HASH = "9f2c1e4a7b3d5f60819a2c4e6b8d0f13579ace2468bdf0123456789abcdef012";
  const ADDRESS = "bc1qar0srrr7xfkvy5l643lydnw9re59gtzzwf5mdq";

  it("finds a payment hash however deeply it is nested", () => {
    expect(extractPaymentHints({ data: { transaction: { initiationVia: { paymentHash: HASH } } } }))
      .toEqual([HASH]);
  });

  it("finds an on-chain address inside an array", () => {
    expect(extractPaymentHints({ events: [{ settlementVia: { address: ADDRESS } }] }))
      .toEqual([ADDRESS]);
  });

  it("returns both when a payload carries both", () => {
    const hints = extractPaymentHints({ a: HASH, b: { c: ADDRESS } });
    expect(hints).toHaveLength(2);
    expect(hints).toContain(HASH);
    expect(hints).toContain(ADDRESS);
  });

  it("ignores prose, ids and amounts — a wrong guess costs a lookup", () => {
    expect(extractPaymentHints({
      type: "receive.lightning",
      memo: "Cleaning subscription for Apartment 4B",
      amount: 75000,
      accountId: "0195aa1e-0f2b-7000-8000-000000000000",
      timestamp: "2026-08-13T12:00:00Z",
    })).toEqual([]);
  });

  it("survives junk without throwing", () => {
    expect(extractPaymentHints(null)).toEqual([]);
    expect(extractPaymentHints("hello")).toEqual([]);
    expect(extractPaymentHints(42)).toEqual([]);
  });

  it("does not recurse forever on a self-referencing payload", () => {
    const loop: Record<string, unknown> = { hash: HASH };
    loop.self = loop;
    expect(extractPaymentHints(loop)).toEqual([HASH]);
  });

  it("stops collecting once the limit is reached", () => {
    const many = Object.fromEntries(
      Array.from({ length: 30 }, (_, i) => [`k${i}`, HASH.slice(0, 63) + (i % 10)]),
    );
    expect(extractPaymentHints(many, 5)).toHaveLength(5);
  });

  it("tells a hash from an address", () => {
    expect(isPaymentHash(HASH)).toBe(true);
    expect(isPaymentHash(ADDRESS)).toBe(false);
  });
});
