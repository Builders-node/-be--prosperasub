import { payerOf } from "./paypal.service";

/**
 * The shapes PayPal actually returns. A capture response carries `payer`; an
 * order read back after a failed capture carries the same block; and some
 * flows (guest checkout with only shipping) carry a name and no payer at all.
 */
describe("payerOf", () => {
  it("reads the payer from a capture response", () => {
    expect(payerOf({
      id: "5O190127TN364715T",
      status: "COMPLETED",
      payer: {
        name: { given_name: "Ivan", surname: "Syrtsov" },
        email_address: "ivan@example.com",
        payer_id: "QYR5Z8XDVJNXQ",
      },
      purchase_units: [{ payments: { captures: [{ id: "3C679366HH908993F", status: "COMPLETED" }] } }],
    })).toEqual({ name: "Ivan Syrtsov", email: "ivan@example.com" });
  });

  it("falls back to the shipping name when there is no payer name", () => {
    expect(payerOf({
      payer: { email_address: "guest@example.com" },
      purchase_units: [{ shipping: { name: { full_name: "Guest Buyer" } } }],
    })).toEqual({ name: "Guest Buyer", email: "guest@example.com" });
  });

  it("copes with a first name and no surname", () => {
    expect(payerOf({ payer: { name: { given_name: "Ana" }, email_address: "ana@example.com" } }))
      .toEqual({ name: "Ana", email: "ana@example.com" });
  });

  it("says nothing rather than guessing", () => {
    expect(payerOf({})).toEqual({ name: null, email: null });
    expect(payerOf(null)).toEqual({ name: null, email: null });
    expect(payerOf({ payer: {} })).toEqual({ name: null, email: null });
  });
});
