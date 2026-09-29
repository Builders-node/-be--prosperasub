import {
  mapNowPaymentsStatus,
  nowPaymentsSignature,
  sortDeep,
  toCryptoPayment,
  usdToCents,
  verifyNowPaymentsSignature,
} from "./nowpayments.gateway";

/**
 * The two things in the NOWPayments adapter that are money-critical and
 * testable without the network: which statuses activate an order, and
 * whether a callback's signature is checked the way NOWPayments computes it.
 */
describe("mapNowPaymentsStatus", () => {
  it.each(["finished", "confirmed", "sending"])("%s is paid", (s) => {
    expect(mapNowPaymentsStatus(s)).toBe("paid");
  });

  it("partially_paid is never paid — an underpayment must not activate a plan", () => {
    expect(mapNowPaymentsStatus("partially_paid")).toBe("partial");
  });

  it.each([
    ["waiting", "waiting"],
    ["confirming", "confirming"],
    ["expired", "expired"],
    ["failed", "failed"],
    ["refunded", "refunded"],
    ["something_new", "waiting"],
    [undefined, "waiting"],
  ])("%s → %s", (s, expected) => {
    expect(mapNowPaymentsStatus(s as string | undefined)).toBe(expected);
  });
});

describe("IPN signature", () => {
  const secret = "test-ipn-secret";
  const body = { payment_status: "finished", payment_id: 5077125051, price_amount: 79, fee: { depositFee: 0, currency: "usdttrc20" } };

  it("is independent of key order at every depth", () => {
    const shuffled = { fee: { currency: "usdttrc20", depositFee: 0 }, price_amount: 79, payment_id: 5077125051, payment_status: "finished" };
    expect(nowPaymentsSignature(shuffled, secret)).toBe(nowPaymentsSignature(body, secret));
    expect(JSON.stringify(sortDeep(shuffled))).toBe(JSON.stringify(sortDeep(body)));
  });

  it("accepts its own signature, case-insensitively", () => {
    const sig = nowPaymentsSignature(body, secret);
    expect(verifyNowPaymentsSignature(body, sig, secret)).toBe(true);
    expect(verifyNowPaymentsSignature(body, sig.toUpperCase(), secret)).toBe(true);
  });

  it("rejects a tampered body, a wrong secret, and a missing header", () => {
    const sig = nowPaymentsSignature(body, secret);
    expect(verifyNowPaymentsSignature({ ...body, price_amount: 1 }, sig, secret)).toBe(false);
    expect(verifyNowPaymentsSignature(body, sig, "other")).toBe(false);
    expect(verifyNowPaymentsSignature(body, undefined, secret)).toBe(false);
    expect(verifyNowPaymentsSignature(body, sig, "")).toBe(false);
  });
});

describe("toCryptoPayment", () => {
  it("keeps the pay amount as a string and the price in cents", () => {
    const p = toCryptoPayment({
      payment_id: 123, payment_status: "waiting", pay_address: "TXyz", payin_extra_id: null,
      pay_amount: 79.123456789012345, pay_currency: "USDTTRC20", price_amount: "79.9",
    });
    expect(p.paymentId).toBe("123");
    expect(typeof p.payAmount).toBe("string");
    expect(p.payCurrency).toBe("usdttrc20");
    expect(p.priceCents).toBe(7990);
    expect(p.state).toBe("waiting");
  });

  it("usdToCents survives float drift", () => {
    expect(usdToCents(0.1 + 0.2)).toBe(30);
    expect(usdToCents("")).toBeNull();
    expect(usdToCents("abc")).toBeNull();
  });
});
