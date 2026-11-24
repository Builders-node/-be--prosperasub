import { HttpError } from "./http.ts";

/**
 * Blink (sending side) — port of BlinkService.sendPayout / satsForCents /
 * usdBalanceCents, with one change that fixes withdrawals:
 *
 *   The platform's money is not all in the USD wallet. Lightning receipts land
 *   there, on-chain ones in the BTC wallet, and on 2026-10-20 USD held $0 while
 *   BTC held ~1.23M sats — every withdrawal failed with "exceeds balance '0'".
 *   So a payout now goes from USD when USD can cover it, otherwise from BTC
 *   when BTC can, and is refused (queued for an admin) only when neither can.
 *
 * Units, from Blink's schema: lnAddressPaymentSend.amount is SATS (either
 * wallet), onChainUsdPaymentSend.amount is CENTS, onChainPaymentSend.amount is
 * SATS. Getting this wrong once sent 100 sats for $1.00.
 */

type Wallet = { id: string; walletCurrency: string; balance: number };

const graphqlUrl = () => Deno.env.get("BLINK_GRAPHQL_URL") || "https://api.blink.sv/graphql";
const payoutKey = () => Deno.env.get("BLINK_PAYOUT_API_KEY") || Deno.env.get("BLINK_API_KEY") || "";
const usdWalletId = () => Deno.env.get("BLINK_WALLET_ID") || "";

export function payoutsEnabled(): boolean {
  const flag = String(Deno.env.get("BLINK_PAYOUTS_ENABLED") ?? "").toLowerCase();
  return ["1", "true", "yes", "on"].includes(flag) && !!payoutKey() && !!usdWalletId();
}

async function request<T>(query: string, variables: Record<string, unknown>): Promise<T> {
  const res = await fetch(graphqlUrl(), {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-API-KEY": payoutKey() },
    body: JSON.stringify({ query, variables }),
  });
  if (!res.ok) throw new HttpError(503, `Blink returned HTTP ${res.status}.`);
  const payload = await res.json() as { data?: T; errors?: Array<{ message?: string }> };
  const error = payload.errors?.find((e) => e.message)?.message;
  if (error) throw new HttpError(503, error);
  if (!payload.data) throw new HttpError(503, "Blink did not return data.");
  return payload.data;
}

/** Both wallets, or null if Blink could not be read (not the same as empty). */
export async function wallets(): Promise<{ usd: Wallet | null; btc: Wallet | null } | null> {
  try {
    const r = await request<{ me?: { defaultAccount?: { wallets?: Wallet[] } } }>(
      `query { me { defaultAccount { wallets { id walletCurrency balance } } } }`, {},
    );
    const all = r.me?.defaultAccount?.wallets ?? [];
    return {
      usd: all.find((w) => w.id === usdWalletId()) ?? all.find((w) => w.walletCurrency === "USD") ?? null,
      btc: all.find((w) => w.walletCurrency === "BTC") ?? null,
    };
  } catch {
    return null;
  }
}

/** Cents → sats at Blink's own rate. Fails closed on a strange price. */
export async function satsForCents(cents: number): Promise<number> {
  const r = await request<{ realtimePrice?: { btcSatPrice?: { base?: number; offset?: number } } }>(
    `query PayoutRate($currency: DisplayCurrency) { realtimePrice(currency: $currency) { btcSatPrice { base offset } } }`,
    { currency: "USD" },
  );
  const base = Number(r.realtimePrice?.btcSatPrice?.base);
  const offset = Number(r.realtimePrice?.btcSatPrice?.offset);
  if (!Number.isFinite(base) || base <= 0 || !Number.isFinite(offset) || offset < 0) {
    throw new HttpError(503, "Could not price this payout — nothing was sent.");
  }
  const centsPerSat = base / 10 ** offset;
  const sats = Math.round(cents / centsPerSat);
  const impliedBtcUsd = (centsPerSat * 100_000_000) / 100;
  if (!Number.isFinite(sats) || sats <= 0 || impliedBtcUsd < 1_000 || impliedBtcUsd > 10_000_000) {
    throw new HttpError(503, "The exchange rate looked wrong — nothing was sent.");
  }
  return sats;
}

/** Headroom kept in the BTC wallet for routing / miner fees. */
const BTC_FEE_BUFFER = (sats: number, kind: string) =>
  kind === "onchain" ? Math.max(Math.ceil(sats * 0.02), 5_000) : Math.max(Math.ceil(sats * 0.01), 50);

export type WalletPlan = { from: "usd" | "btc"; walletId: string } | { from: "none"; reason: string } | { from: "unknown" };

/**
 * Which wallet can pay this. `unknown` = Blink unreadable: do not refuse on a
 * transient error, try USD and let the send itself fail cleanly if short.
 */
export async function planWallet(cents: number, kind: "lightning_address" | "onchain"): Promise<WalletPlan> {
  const w = await wallets();
  if (!w) return { from: "unknown" };
  if (w.usd && w.usd.balance >= cents) return { from: "usd", walletId: w.usd.id };
  if (w.btc) {
    const sats = await satsForCents(cents);
    if (w.btc.balance >= sats + BTC_FEE_BUFFER(sats, kind)) return { from: "btc", walletId: w.btc.id };
  }
  return { from: "none", reason: `usd ${w.usd?.balance ?? 0}c, btc ${w.btc?.balance ?? 0}sat, asked ${cents}c` };
}

export async function sendPayout(input: {
  destination: { kind: "lightning_address" | "onchain"; value: string };
  amountCents: number;
  memo: string;
  wallet: { from: "usd" | "btc"; walletId: string };
}): Promise<{ status: "SUCCESS" | "PENDING" | "FAILURE" | "ALREADY_PAID"; error: string | null; sentAmount: number; sentUnit: "sat" | "cent" }> {
  const cents = Math.round(input.amountCents);
  if (!Number.isFinite(cents) || cents <= 0) throw new HttpError(503, "A payout needs a positive amount.");
  const { walletId, from } = input.wallet;
  const ln = input.destination.kind === "lightning_address";
  // Lightning: sats from either wallet. On-chain: cents from USD, sats from BTC.
  const unit: "sat" | "cent" = ln || from === "btc" ? "sat" : "cent";
  const amount = unit === "sat" ? await satsForCents(cents) : cents;

  let result: { status?: string; errors?: Array<{ message?: string }> } | undefined;
  // A Lightning address ON Blink (name@blink.sv) is another Blink account.
  // Blink refuses to pay its own users over LNURL ("LNURL service unreachable
  // or not allowed"), so it is paid inside Blink instead: the user's default
  // wallet in the same currency we pay from, by username. Same units rule —
  // intraLedgerUsdPaymentSend takes CENTS, intraLedgerPaymentSend SATS.
  const blinkUser = ln ? blinkUsername(input.destination.value) : null;
  if (blinkUser) {
    const currency = from === "btc" ? "BTC" : "USD";
    const r = await request<{ accountDefaultWallet?: { id?: string } }>(
      `query($username: Username!, $walletCurrency: WalletCurrency) { accountDefaultWallet(username: $username, walletCurrency: $walletCurrency) { id } }`,
      { username: blinkUser, walletCurrency: currency },
    ).catch((e) => { throw new HttpError(503, `No Blink account called "${blinkUser}" — check the address. (${(e as Error).message})`); });
    const recipientWalletId = r.accountDefaultWallet?.id;
    if (!recipientWalletId) throw new HttpError(503, `No Blink account called "${blinkUser}" — check the address.`);
    const intraUnit: "sat" | "cent" = from === "btc" ? "sat" : "cent";
    const intraAmount = intraUnit === "sat" ? await satsForCents(cents) : cents;
    const field = from === "btc" ? "intraLedgerPaymentSend" : "intraLedgerUsdPaymentSend";
    const inputType = from === "btc" ? "IntraLedgerPaymentSendInput" : "IntraLedgerUsdPaymentSendInput";
    const out = await request<Record<string, typeof result>>(
      `mutation($input: ${inputType}!) { ${field}(input: $input) { status errors { message } } }`,
      { input: { walletId, recipientWalletId, amount: intraAmount, memo: input.memo } },
    );
    const res = out[field];
    const err = res?.errors?.find((e) => e.message)?.message ?? null;
    const st = (res?.status ?? (err ? "FAILURE" : "PENDING")).toUpperCase();
    const ok = ["SUCCESS", "PENDING", "FAILURE", "ALREADY_PAID"].includes(st);
    return { status: (ok ? st : "FAILURE") as "SUCCESS", error: err, sentAmount: intraAmount, sentUnit: intraUnit };
  }
  if (ln) {
    result = (await request<{ lnAddressPaymentSend?: typeof result }>(
      `mutation($input: LnAddressPaymentSendInput!) { lnAddressPaymentSend(input: $input) { status errors { message } } }`,
      { input: { walletId, lnAddress: input.destination.value, amount } },
    )).lnAddressPaymentSend;
  } else if (from === "usd") {
    result = (await request<{ onChainUsdPaymentSend?: typeof result }>(
      `mutation($input: OnChainUsdPaymentSendInput!) { onChainUsdPaymentSend(input: $input) { status errors { message } } }`,
      { input: { walletId, address: input.destination.value, amount, memo: input.memo } },
    )).onChainUsdPaymentSend;
  } else {
    result = (await request<{ onChainPaymentSend?: typeof result }>(
      `mutation($input: OnChainPaymentSendInput!) { onChainPaymentSend(input: $input) { status errors { message } } }`,
      { input: { walletId, address: input.destination.value, amount, memo: input.memo } },
    )).onChainPaymentSend;
  }
  const error = result?.errors?.find((e) => e.message)?.message ?? null;
  const status = (result?.status ?? (error ? "FAILURE" : "PENDING")).toUpperCase();
  const known = ["SUCCESS", "PENDING", "FAILURE", "ALREADY_PAID"].includes(status);
  return { status: (known ? status : "FAILURE") as "SUCCESS", error, sentAmount: amount, sentUnit: unit };
}

/** "name@blink.sv" → "name"; anything not on Blink → null. */
export function blinkUsername(address: string): string | null {
  const m = /^([a-z0-9_]{3,50})@(?:pay\.)?blink\.sv$/i.exec(String(address ?? "").trim());
  return m ? m[1] : null;
}

// ── Destination (port of payments/payout-destination.ts) ───────────────────────
export type PayoutDestination =
  | { kind: "lightning_address"; value: string } | { kind: "onchain"; value: string }
  | { kind: "invoice"; value: string } | { kind: "unknown"; value: string };
const LN_ADDRESS = /^[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}$/i;
const ONCHAIN = /^(bc1[a-z0-9]{20,80}|[13][a-km-zA-HJ-NP-Z1-9]{25,39})$/;
const INVOICE = /^lnbc[0-9a-z]+$/i;

export function classifyPayoutDestination(raw: string | null | undefined): PayoutDestination {
  const value = (raw ?? "").trim();
  const bare = value.replace(/^(lightning:|bitcoin:)/i, "").split("?")[0].trim();
  if (LN_ADDRESS.test(bare)) return { kind: "lightning_address", value: bare.toLowerCase() };
  if (INVOICE.test(bare)) return { kind: "invoice", value: bare.toLowerCase() };
  if (ONCHAIN.test(bare)) return { kind: "onchain", value: bare };
  return { kind: "unknown", value };
}

export function payoutDestinationProblem(dest: PayoutDestination): string | null {
  switch (dest.kind) {
    case "lightning_address": case "onchain": return null;
    case "invoice": return "A Lightning invoice expires and fixes its own amount. Use a Lightning address (you@wallet.com) or a Bitcoin address instead.";
    default: return "That doesn't look like a Lightning address (you@wallet.com) or a Bitcoin address.";
  }
}
