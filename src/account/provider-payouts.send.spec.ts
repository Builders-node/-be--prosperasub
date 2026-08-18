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
    {
      payoutsEnabled: blink.payoutsEnabled ?? true,
      sendPayout,
      usdBalanceCents: (blink as any).usdBalanceCents ?? jest.fn().mockResolvedValue(1_000_000),
    } as any,
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
    payoutsEnabled?: boolean; sendPayout?: jest.Mock; usdBalanceCents?: jest.Mock;
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
      { payoutsEnabled: opts.payoutsEnabled, sendPayout: opts.sendPayout,
        usdBalanceCents: opts.usdBalanceCents } as any,
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


describe("ProviderPayoutsService — the wallet has to cover it", () => {
  const ROW: Row = {
    id: "11111111-2222-3333-4444-555555555555",
    provider_id: "p1", amount_cents: 5000, status: "approved", destination: "elias@blink.sv",
  };

  it("refuses before claiming when the USD wallet is short", async () => {
    const { svc, store, sendPayout } = serviceWith(ROW, {
      usdBalanceCents: jest.fn().mockResolvedValue(1_000),
    } as any);
    await expect(svc.send(ROW.id, "admin-1")).rejects.toThrow(/temporarily unavailable/);
    expect(sendPayout).not.toHaveBeenCalled();
    // Untouched — nothing to unwind, because nothing was claimed.
    expect(store.status).toBe("approved");
  });

  it("sends when the balance covers it exactly", async () => {
    const { svc, sendPayout } = serviceWith(ROW, {
      usdBalanceCents: jest.fn().mockResolvedValue(5_000),
    } as any);
    await svc.send(ROW.id, "admin-1");
    expect(sendPayout).toHaveBeenCalledTimes(1);
  });

  it("a balance it cannot read does not hold up the payment", async () => {
    // Fail-open on purpose: a transient error must not withhold money that
    // would have sent, and a genuinely short wallet still fails at the send.
    const { svc, sendPayout } = serviceWith(ROW, {
      usdBalanceCents: jest.fn().mockResolvedValue(null),
    } as any);
    await svc.send(ROW.id, "admin-1");
    expect(sendPayout).toHaveBeenCalledTimes(1);
  });
});

/**
 * Who may see the money, and who may move it.
 *
 * A manager runs the business day to day; the payout ledger is the owner's.
 * These two rules used to be one, which is why the Money tab was hidden from
 * managers entirely rather than shown without its button.
 */
describe("ProviderPayoutsService — manager vs owner", () => {
  function svcFor(provider: { admin_user_id: string | null }, members: string[]) {
    const svc = new ProviderPayoutsService(
      { get: () => undefined } as any,
      { summarize: jest.fn().mockResolvedValue({ availableCents: 500, earnedCents: 500, committedCents: 0 }) } as any,
      { payoutsEnabled: false } as any,
    );
    (svc as any).rest = jest.fn(async (path: string) => {
      if (path.startsWith("providers?id=eq.")) return [provider];
      if (path.startsWith("provider_members?")) {
        const uid = /user_id=eq\.([^&]+)/.exec(path)?.[1];
        return members.includes(String(uid)) ? [{ id: "m1" }] : [];
      }
      return [];
    });
    return svc;
  }

  const OWNED = { admin_user_id: "owner-1" };

  it("lets a manager read the balance, and says they cannot withdraw", async () => {
    const svc = svcFor(OWNED, ["manager-1"]);
    const out: any = await svc.available("manager-1", "p1");
    expect(out.availableCents).toBe(500);
    expect(out.canWithdraw).toBe(false);
  });

  it("tells the owner they can", async () => {
    const svc = svcFor(OWNED, []);
    const out: any = await svc.available("owner-1", "p1");
    expect(out.canWithdraw).toBe(true);
  });

  it("refuses a manager's withdrawal outright", async () => {
    const svc = svcFor(OWNED, ["manager-1"]);
    (svc as any).post = jest.fn();
    await expect(svc.request(
      { providerId: "p1", amountCents: 100, destination: "elias@blink.sv" },
      "manager-1",
    )).rejects.toThrow(/don't own this business/);
    expect((svc as any).post).not.toHaveBeenCalled();
  });

  it("refuses a stranger even the reading", async () => {
    const svc = svcFor(OWNED, []);
    await expect(svc.available("nobody", "p1")).rejects.toThrow(/don't run this business/);
  });

  it("a platform-run business with no owner is not therefore everyone's", async () => {
    // Beach Club has admin_user_id NULL. A manager may read it; nobody but a
    // platform admin may withdraw from it.
    const svc = svcFor({ admin_user_id: null }, ["manager-1"]);
    const out: any = await svc.available("manager-1", "p1");
    expect(out.canWithdraw).toBe(false);
    await expect(svc.available("stranger", "p1")).rejects.toThrow(/don't run this business/);
  });
});
