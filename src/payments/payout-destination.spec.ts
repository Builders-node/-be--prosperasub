import { classifyPayoutDestination, payoutDestinationProblem } from "./payout-destination";

/**
 * This decides where real money goes, so the cases that matter are the ones
 * that must NOT be classified as payable.
 */
describe("classifyPayoutDestination", () => {
  it("reads a Lightning address, lowercased", () => {
    expect(classifyPayoutDestination("Elias@Blink.sv"))
      .toEqual({ kind: "lightning_address", value: "elias@blink.sv" });
  });

  it("reads the on-chain forms", () => {
    expect(classifyPayoutDestination("bc1qar0srrr7xfkvy5l643lydnw9re59gtzzwf5mdq").kind).toBe("onchain");
    expect(classifyPayoutDestination("1BvBMSEYstWetqTFn5Au4m4GFg7xJaNVN2").kind).toBe("onchain");
    expect(classifyPayoutDestination("3J98t1WpEZ73CNmQviecrnyiWrnqRhWNLy").kind).toBe("onchain");
  });

  it("strips the URI prefixes wallets hand out", () => {
    expect(classifyPayoutDestination("bitcoin:bc1qar0srrr7xfkvy5l643lydnw9re59gtzzwf5mdq?amount=0.01").kind)
      .toBe("onchain");
    expect(classifyPayoutDestination("lightning:elias@blink.sv").kind).toBe("lightning_address");
  });

  it("recognises an invoice as an invoice, not as payable", () => {
    const dest = classifyPayoutDestination("lnbc20m1pvjluezpp5qqqsyqcyq5rqwzqfqqqsyqcyq5rqwzqfqqqsyqcyq5rqwzqfq");
    expect(dest.kind).toBe("invoice");
    expect(payoutDestinationProblem(dest)).toMatch(/expires/);
  });

  it("refuses everything it does not understand", () => {
    for (const junk of ["", "   ", "not an address", "elias@", "@blink.sv", "bc1", "0xAbC123", "https://blink.sv/elias"]) {
      const dest = classifyPayoutDestination(junk);
      expect(dest.kind).toBe("unknown");
      expect(payoutDestinationProblem(dest)).toBeTruthy();
    }
  });

  it("passes only the two forms we can actually send", () => {
    expect(payoutDestinationProblem(classifyPayoutDestination("elias@blink.sv"))).toBeNull();
    expect(payoutDestinationProblem(classifyPayoutDestination("bc1qar0srrr7xfkvy5l643lydnw9re59gtzzwf5mdq"))).toBeNull();
  });
});
