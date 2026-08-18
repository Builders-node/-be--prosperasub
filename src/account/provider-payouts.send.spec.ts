import { BadRequestException } from "@nestjs/common";
import { ProviderPayoutsService } from "./provider-payouts.service";

/**
 * The send path, exercised against a fake PostgREST.
 *
 * These are the cases where a bug costs money rather than a screen: paying
 * twice, marking a refusal as paid, and leaving a failure counted against the
 * provider's balance.
 */

type Row = Record<string, any>;

function serviceWith(
  row: Row,
  blink: Partial<{ payoutsEnabled: boolean; sendPayout: jest.Mock }> = {},
  summarize?: jest.Mock,
) {
  const store: Row = { ...row };
  const sendPayout = blink.sendPayout ?? jest.fn().mockResolvedValue({ status: "SUCCESS", error: null });

  const svc = new ProviderPayoutsService(
    { get: () => undefined } as any,
    { summarize: summarize ?? jest.fn() } as any,
    { payoutsEnabled: blink.payoutsEnabled ?? true, sendPayout } as any,
  );

  // Stand in for the REST helpers. `patch` honours a `status=eq.` filter the
  // same way PostgREST does — returning no rows when it no longer matches — so
  // the compare-and-set under test is actually being tested.
  (svc as any).rest = jest.fn(async (path: string) => {
    if (path.startsWith("provider_payouts?id=eq.")) return [{ ...store }];
    if (path.startsWith("providers?id=eq.")) return [{ admin_user_id: "owner-1", name: "Beach Club" }];
    if (path.startsWith("global_settings?key=eq.payouts_min_cents")) return [];
    return [];
  });
  (svc as any).patch = jest.fn(async (path: string, body: Row) => {
    const required = /status=eq\.([a-z]+)/.exec(path)?.[1];
    if (required && store.status !== required) return [];
    Object.assign(store, body);
    return [{ ...store }];
  });
  (svc as any).post = jest.fn(async () => [{}]);

  return { svc, store, sendPayout };
}

const APPROVED: Row = {
  id: "11111111-2222-3333-4444-555555555555",
  provider_id: "p1",
  amount_cents: 5000,
  status: "approved",
  destination: "elias@blink.sv",
};

describe("ProviderPayoutsService.send", () => {
  it("sends once, and the second attempt is refused rather than paying again", async () => {
    const { svc, store, sendPayout } = serviceWith(APPROVED);

    await svc.send(APPROVED.id, "admin-1");
    expect(store.status).toBe("paid");
    expect(sendPayout).toHaveBeenCalledTimes(1);

    await expect(svc.send(APPROVED.id, "admin-1")).rejects.toBeInstanceOf(BadRequestException);
    expect(sendPayout).toHaveBeenCalledTimes(1);
  });

  it("sends the approved amount in cents, to the classified destination", async () => {
    const { svc, sendPayout } = serviceWith(APPROVED);
    await svc.send(APPROVED.id, "admin-1");
    expect(sendPayout).toHaveBeenCalledWith(expect.objectContaining({
      amountCents: 5000,
      destination: { kind: "lightning_address", value: "elias@blink.sv" },
    }));
  });

  it("a refusal lands as failed with Blink's own words, never as paid", async () => {
    const { svc, store } = serviceWith(APPROVED, {
      sendPayout: jest.fn().mockResolvedValue({ status: "FAILURE", error: "no route to destination" }),
    });
    const row = await svc.send(APPROVED.id, "admin-1");
    expect(row.status).toBe("failed");
    expect(store.send_error).toBe("no route to destination");
    expect(store.paid_at).toBeUndefined();
  });

  it("a throwing call does not go back to approved — nobody knows if money left", async () => {
    const { svc, store } = serviceWith(APPROVED, {
      sendPayout: jest.fn().mockRejectedValue(new Error("socket hang up")),
    });
    const row = await svc.send(APPROVED.id, "admin-1");
    expect(row.status).toBe("failed");
    expect(store.send_error).toMatch(/socket hang up/);
  });

  it("pending stays in flight, so it is still committed and not re-sendable", async () => {
    const { svc, store } = serviceWith(APPROVED, {
      sendPayout: jest.fn().mockResolvedValue({ status: "PENDING", error: null }),
    });
    const row = await svc.send(APPROVED.id, "admin-1");
    expect(row.status).toBe("sending");
    expect(store.paid_at).toBeUndefined();
    await expect(svc.send(APPROVED.id, "admin-1")).rejects.toThrow(/already on its way/);
  });

  it("refuses a payout that has not been approved", async () => {
    for (const status of ["requested", "paid", "rejected", "failed"]) {
      const { svc, sendPayout } = serviceWith({ ...APPROVED, status });
      await expect(svc.send(APPROVED.id, "admin-1")).rejects.toBeInstanceOf(BadRequestException);
      expect(sendPayout).not.toHaveBeenCalled();
    }
  });

  it("refuses a destination it cannot pay, before claiming the row", async () => {
    const { svc, store, sendPayout } = serviceWith({ ...APPROVED, destination: "lnbc20m1pvjluez" });
    await expect(svc.send(APPROVED.id, "admin-1")).rejects.toThrow(/Lightning address/);
    expect(sendPayout).not.toHaveBeenCalled();
    expect(store.status).toBe("approved");
  });

  it("does nothing at all when sending is switched off", async () => {
    const { svc, sendPayout } = serviceWith(APPROVED, { payoutsEnabled: false });
    await expect(svc.send(APPROVED.id, "admin-1")).rejects.toThrow(/switched off/);
    expect(sendPayout).not.toHaveBeenCalled();
  });
});


/**
 * Withdrawing with no approval in the way.
 *
 * With sending configured the provider's own button pays them, so the ceiling
 * and the race are the only things standing between a balance and the wallet.
 */
describe("ProviderPayoutsService.request — instant", () => {
  const OWNER = "owner-1";
  const PROVIDER = "p1";

  function instantService(opts: {
    available: number; earned?: number; committedAfter?: number;
    payoutsEnabled?: boolean; sendPayout?: jest.Mock;
  }) {
    const earned = opts.earned ?? opts.available;
    const summarize = jest.fn()
      // The check before the claim…
      .mockResolvedValueOnce({
        availableCents: opts.available, earnedCents: earned, committedCents: earned - opts.available,
      })
      // …and the re-read after it, which is what catches a concurrent one.
      .mockResolvedValue({
        availableCents: 0, earnedCents: earned, committedCents: opts.committedAfter ?? earned,
      });

    const { svc, store, sendPayout } = serviceWith(
      { id: "row-1", provider_id: PROVIDER, status: "sending", destination: "elias@blink.sv", amount_cents: 0 },
      { payoutsEnabled: opts.payoutsEnabled, sendPayout: opts.sendPayout },
      summarize,
    );
    (svc as any).assertOwner = jest.fn();
    (svc as any).post = jest.fn(async (_path: string, body: Row) => {
      Object.assign(store, body, { id: "row-1" });
      return [{ ...store }];
    });
    return { svc, store, sendPayout };
  }

  it("pays immediately instead of filing a request", async () => {
    const { svc, store, sendPayout } = instantService({ available: 10_000 });
    const row = await svc.request(
      { providerId: PROVIDER, amountCents: 4_000, destination: "elias@blink.sv" },
      OWNER,
    );
    expect(row.status).toBe("paid");
    expect(store.paid_at).toBeTruthy();
    expect(sendPayout).toHaveBeenCalledWith(expect.objectContaining({ amountCents: 4_000 }));
  });

  it("still files a request when the platform cannot send", async () => {
    const { svc, sendPayout } = instantService({ available: 10_000, payoutsEnabled: false });
    (svc as any).notifyAdminsOfRequest = jest.fn().mockResolvedValue(undefined);
    const row = await svc.request(
      { providerId: PROVIDER, amountCents: 4_000, destination: "elias@blink.sv" },
      OWNER,
    );
    expect(row.status).toBe("requested");
    expect(sendPayout).not.toHaveBeenCalled();
  });

  it("refuses more than the balance, with no person in the way to catch it", async () => {
    const { svc, sendPayout } = instantService({ available: 3_000 });
    await expect(svc.request(
      { providerId: PROVIDER, amountCents: 4_000, destination: "elias@blink.sv" },
      OWNER,
    )).rejects.toThrow(/withdraw up to/);
    expect(sendPayout).not.toHaveBeenCalled();
  });

  it("voids itself rather than sending when another withdrawal claimed the same money", async () => {
    // The re-read after claiming reports more committed than earned — which is
    // what two concurrent withdrawals of the same balance look like.
    const { svc, store, sendPayout } = instantService({
      available: 5_000, earned: 5_000, committedAfter: 9_000,
    });
    await expect(svc.request(
      { providerId: PROVIDER, amountCents: 5_000, destination: "elias@blink.sv" },
      OWNER,
    )).rejects.toThrow(/already in progress/);
    expect(sendPayout).not.toHaveBeenCalled();
    expect(store.status).toBe("rejected");
  });

  it("refuses dust, which would cost more in routing than it moves", async () => {
    const { svc, sendPayout } = instantService({ available: 10_000 });
    await expect(svc.request(
      { providerId: PROVIDER, amountCents: 40, destination: "elias@blink.sv" },
      OWNER,
    )).rejects.toThrow(/smallest withdrawal/);
    expect(sendPayout).not.toHaveBeenCalled();
  });

  it("refuses a destination it cannot pay before writing anything", async () => {
    const { svc, store } = instantService({ available: 10_000 });
    await expect(svc.request(
      { providerId: PROVIDER, amountCents: 4_000, destination: "not an address" },
      OWNER,
    )).rejects.toThrow(/Lightning address/);
    expect(store.status).toBe("sending"); // untouched fixture, nothing was written
  });
});
