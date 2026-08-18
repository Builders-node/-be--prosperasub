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

function serviceWith(row: Row, blink: Partial<{ payoutsEnabled: boolean; sendPayout: jest.Mock }> = {}) {
  const store: Row = { ...row };
  const sendPayout = blink.sendPayout ?? jest.fn().mockResolvedValue({ status: "SUCCESS", error: null });

  const svc = new ProviderPayoutsService(
    { get: () => undefined } as any,
    { summarize: jest.fn() } as any,
    { payoutsEnabled: blink.payoutsEnabled ?? true, sendPayout } as any,
  );

  // Stand in for the REST helpers. `patch` honours a `status=eq.` filter the
  // same way PostgREST does — returning no rows when it no longer matches — so
  // the compare-and-set under test is actually being tested.
  (svc as any).rest = jest.fn(async (path: string) => {
    if (path.startsWith("provider_payouts?id=eq.")) return [{ ...store }];
    if (path.startsWith("providers?id=eq.")) return [{ admin_user_id: "owner-1", name: "Beach Club" }];
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
