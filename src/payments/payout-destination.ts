/**
 * What a provider typed into "Where to send it".
 *
 * The field has always been free text and was never checked, so a payout could
 * sit approved for days with a typo in it and only fail at the wallet. Now the
 * same function runs twice: when the request is made, so the provider is told
 * immediately, and again before sending, so nothing is paid to a string we do
 * not understand.
 */

export type PayoutDestination =
  | { kind: "lightning_address"; value: string }
  | { kind: "onchain"; value: string }
  | { kind: "invoice"; value: string }
  | { kind: "unknown"; value: string };

/** user@domain.tld — the only Lightning form that can be paid a chosen amount. */
const LN_ADDRESS = /^[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}$/i;

/** bech32 (bc1…), and the two legacy base58 forms. Mainnet only. */
const ONCHAIN = /^(bc1[a-z0-9]{20,80}|[13][a-km-zA-HJ-NP-Z1-9]{25,39})$/;

const INVOICE = /^lnbc[0-9a-z]+$/i;

export function classifyPayoutDestination(raw: string | null | undefined): PayoutDestination {
  const value = (raw ?? "").trim();
  // Wallets hand out "lightning:" and "bitcoin:" URIs; a person pasting one has
  // given us a perfectly good address with a prefix on it.
  const bare = value.replace(/^(lightning:|bitcoin:)/i, "").split("?")[0].trim();

  if (LN_ADDRESS.test(bare)) return { kind: "lightning_address", value: bare.toLowerCase() };
  if (INVOICE.test(bare)) return { kind: "invoice", value: bare.toLowerCase() };
  if (ONCHAIN.test(bare)) return { kind: "onchain", value: bare };
  return { kind: "unknown", value };
}

/**
 * Whether this platform can pay it, and why not when it cannot.
 *
 * A BOLT11 invoice is refused on purpose rather than for lack of an API call:
 * it carries its own amount and its own expiry, so paying one would either
 * send a figure nobody approved or fail hours later because it went stale. A
 * Lightning address takes the amount we decide, which is the one we checked
 * against the provider's balance.
 */
export function payoutDestinationProblem(dest: PayoutDestination): string | null {
  switch (dest.kind) {
    case "lightning_address":
    case "onchain":
      return null;
    case "invoice":
      return "A Lightning invoice expires and fixes its own amount. Use a Lightning address (you@wallet.com) or a Bitcoin address instead.";
    default:
      return "That doesn't look like a Lightning address (you@wallet.com) or a Bitcoin address.";
  }
}
