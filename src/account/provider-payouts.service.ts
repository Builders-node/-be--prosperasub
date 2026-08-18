import { BadRequestException, ForbiddenException, Injectable, Logger, NotFoundException } from "@nestjs/common";
import { ProviderEarningsService } from "./provider-earnings.service";
import { ConfigService } from "@nestjs/config";
import { BlinkService } from "../payments/blink.service";
import { classifyPayoutDestination, payoutDestinationProblem } from "../payments/payout-destination";

/**
 * The payout ledger.
 *
 * `provider_payouts` is the one table on this platform with RLS on and no
 * policies — the browser cannot see or touch it with the anon key. Everything
 * about it therefore goes through here, with the service role.
 *
 * Two audiences, one table:
 *   • the owner of a provider reads their own rows;
 *   • an admin reads any and writes them.
 *
 * Ownership is `providers.admin_user_id`, deliberately not the per-service
 * manager tables. A manager runs the business day to day; what the business
 * has been paid is the owner's.
 */

export interface PayoutRow {
  id: string;
  provider_id: string;
  amount_cents: number;
  currency: string;
  period_start: string | null;
  period_end: string | null;
  method: string | null;
  reference: string | null;
  note: string | null;
  paid_at: string;
  created_by: string | null;
  created_at: string;
  status?: "requested" | "approved" | "sending" | "paid" | "failed" | "rejected";
  destination?: string | null;
  send_error?: string | null;
}

export interface CreatePayoutInput {
  providerId: string;
  amountCents: number;
  periodStart?: string | null;
  periodEnd?: string | null;
  method?: string | null;
  reference?: string | null;
  note?: string | null;
  paidAt?: string | null;
}

export interface RequestPayoutInput {
  providerId: string;
  amountCents: number;
  /** Lightning address or on-chain BTC address — where the money goes. */
  destination: string;
  note?: string | null;
}

@Injectable()
export class ProviderPayoutsService {
  private readonly logger = new Logger(ProviderPayoutsService.name);

  constructor(
    private readonly config: ConfigService,
    private readonly earnings: ProviderEarningsService,
    private readonly blink: BlinkService,
  ) {}

  /**
   * A provider asking to be paid.
   *
   * The cap is recomputed here and only here. The Money tab shows the same
   * number, but a limit the browser calculates is a suggestion — this endpoint
   * is what stops a request for money that was never earned. Requests land as
   * When the platform can send (a write-scoped Blink key), this pays out
   * **immediately** — the provider presses Withdraw and the money goes. There
   * is no approval step to wait for, because there is nothing a person adds
   * to it: the amount was already earned, the ceiling is computed here and not
   * in the browser, and an admin approving would only be re-reading the same
   * number a day later.
   *
   * What replaces the person is the claim-then-verify below. Without sending
   * configured it falls back to the old behaviour: a `requested` row for an
   * admin to approve and pay by hand.
   */
  async request(input: RequestPayoutInput, userId: string, isAdmin = false): Promise<PayoutRow> {
    await this.assertOwner(userId, input.providerId, isAdmin);

    const amount = Math.round(Number(input.amountCents));
    if (!Number.isFinite(amount) || amount <= 0) {
      throw new BadRequestException("A payout amount must be a positive number of cents.");
    }
    const destination = (input.destination ?? "").trim();
    if (!destination) {
      throw new BadRequestException("Where should the money go? Add a Lightning or Bitcoin address.");
    }
    // Checked here as well as at send time. The field used to take anything,
    // so a typo could sit approved for days and only surface at the wallet —
    // by which point the provider had been told the money was on its way.
    const problem = payoutDestinationProblem(classifyPayoutDestination(destination));
    if (problem) throw new BadRequestException(problem);

    const summary = await this.earnings.summarize(input.providerId);
    if (amount > summary.availableCents) {
      throw new BadRequestException(
        `You can withdraw up to $${(summary.availableCents / 100).toFixed(2)} right now ` +
        `(earned $${(summary.earnedCents / 100).toFixed(2)}, already requested or paid ` +
        `$${(summary.committedCents / 100).toFixed(2)}).`,
      );
    }

    const instant = this.blink.payoutsEnabled;

    // A floor, because each payout is a real Lightning payment that costs the
    // platform a fee to route. Without one, "withdraw" is a button that can be
    // pressed a hundred times for a cent.
    if (instant) {
      const min = await this.minimumCents();
      if (amount < min) {
        throw new BadRequestException(`The smallest withdrawal is $${(min / 100).toFixed(2)}.`);
      }
      await this.assertWalletCanCover(amount);
    }

    const now = new Date().toISOString();
    const created = await this.post<PayoutRow[]>("provider_payouts", {
      provider_id: input.providerId,
      amount_cents: amount,
      // Claimed before it is sent. `sending` counts as committed, so the row
      // itself is what stops a second withdrawal racing this one — see below.
      status: instant ? "sending" : "requested",
      destination,
      note: input.note || null,
      requested_by: userId,
      requested_at: now,
      created_by: userId,
      paid_at: null,
    });
    const row = created?.[0];
    if (!row) throw new BadRequestException("The request could not be recorded.");

    if (!instant) {
      this.logger.log(`[payout] request ${amount} from provider ${input.providerId} by ${userId}`);
      await this.notifyAdminsOfRequest(row).catch((err) =>
        this.logger.warn(`[payout] ${row.id}: could not notify admins — ${String(err)}`));
      return row;
    }

    // Verify AFTER claiming. The check above read a balance and then acted on
    // it, which is fine one at a time and wrong when two withdrawals arrive
    // together: both would see the same room and both would pass. Now each one
    // has already written its claim, so re-reading the total tells us whether
    // the two of them together exceed what was earned — and the one that finds
    // it does voids itself rather than sending.
    const after = await this.earnings.summarize(input.providerId);
    if (after.committedCents > after.earnedCents) {
      await this.finish(row.id, "rejected", {
        decision_note: "Another withdrawal was in flight; this one would have exceeded the balance.",
      });
      throw new BadRequestException(
        "Another withdrawal is already in progress. Check your payouts and try again.",
      );
    }

    this.logger.log(`[payout] instant ${amount} for provider ${input.providerId} by ${userId}`);
    return this.dispatch(row);
  }

  /**
   * Refuse before claiming when the wallet plainly cannot cover it.
   *
   * Payouts leave the USD wallet, and that wallet is not the whole platform's
   * money: Lightning receipts land in it, on-chain ones land in the BTC wallet
   * beside it. So it can be empty on a day the business is doing fine, and
   * without this the provider learns that by pressing a button that says the
   * payment cannot be pulled back.
   *
   * A balance we cannot read is not a refusal. Blocking on a transient error
   * would hold up money that would have sent — the send itself fails cleanly
   * if the funds really are short, and that path is already handled.
   */
  private async assertWalletCanCover(amountCents: number): Promise<void> {
    const balance = await this.blink.usdBalanceCents();
    if (balance == null) return;
    if (balance >= amountCents) return;
    this.logger.warn(`[payout] wallet short: ${balance}c available, ${amountCents}c asked`);
    throw new BadRequestException(
      "Payouts are temporarily unavailable — the platform wallet is being topped up. Try again shortly.",
    );
  }

  /** The smallest payout worth a routing fee. */
  private async minimumCents(): Promise<number> {
    const rows = await this.rest<Array<{ value: unknown }>>(
      "global_settings?key=eq.payouts_min_cents&select=value&limit=1",
    );
    const value = Number(rows?.[0]?.value);
    return Number.isFinite(value) && value > 0 ? Math.round(value) : 100;
  }

  /** What a provider may withdraw right now, and the arithmetic behind it. */
  async available(userId: string, providerId: string, isAdmin = false) {
    await this.assertOwner(userId, providerId, isAdmin);
    return this.earnings.summarize(providerId);
  }

  /** Admin decision on a request: approve, reject, or mark the money sent. */
  async decide(id: string, decision: "approved" | "rejected" | "paid", adminId: string | null, note?: string | null): Promise<PayoutRow> {
    const now = new Date().toISOString();
    const patch: Record<string, unknown> = {
      status: decision,
      decided_by: adminId,
      decided_at: now,
      decision_note: note || null,
    };
    // Only "paid" means money actually moved, so only it stamps paid_at.
    if (decision === "paid") patch.paid_at = now;

    const updated = await this.patch<PayoutRow[]>(`provider_payouts?id=eq.${encodeURIComponent(id)}`, patch);
    const row = updated?.[0];
    if (!row) throw new NotFoundException("Payout not found.");
    this.logger.log(`[payout] ${id} → ${decision} by ${adminId ?? "unknown"}`);
    // The provider was told they would hear back. Keep that promise here
    // rather than leaving them to poll the Money tab.
    await this.notifyDecision(row, decision, note ?? null).catch((err) =>
      this.logger.warn(`[payout] ${id}: could not notify — ${String(err)}`));
    return row;
  }

  /**
   * Actually send an approved payout, over Lightning or on-chain.
   *
   * The one place on this platform where money leaves. Everything about it is
   * shaped by that:
   *
   *   • **It cannot double-send.** The row is moved `approved → sending` with
   *     a conditional write, and the update is rejected if anything else got
   *     there first. Two admins on two laptops, or one admin double-clicking,
   *     produce one payment. This is why `sending` exists as a state rather
   *     than being tracked in memory.
   *
   *   • **A failure never reads as paid.** Only SUCCESS writes `paid` and
   *     stamps `paid_at`; a refusal writes `failed` with Blink's own words,
   *     which releases the amount back into the provider's available balance
   *     because `committed` counts requested/approved/sending/paid and not
   *     failed.
   *
   *   • **PENDING stays in flight.** A Lightning payment still routing, or an
   *     on-chain one broadcast and unconfirmed, is money already gone. It
   *     stays `sending` — committed, not payable again — rather than being
   *     retried into a second payment.
   *
   *   • **The amount is the approved one**, in cents, sent from the USD
   *     wallet. No sats conversion sits in between, so a BTC price that moved
   *     since approval cannot change what the provider receives.
   */
  async send(id: string, adminId: string | null): Promise<PayoutRow> {
    if (!this.blink.payoutsEnabled) {
      throw new BadRequestException(
        "Sending from Blink is switched off. Set BLINK_PAYOUTS_ENABLED with a write-scoped key, or mark the payout as paid by hand.",
      );
    }

    const rows = await this.rest<PayoutRow[]>(
      `provider_payouts?id=eq.${encodeURIComponent(id)}&select=*&limit=1`,
    );
    const payout = rows?.[0];
    if (!payout) throw new NotFoundException("Payout not found.");
    if (payout.status !== "approved") {
      throw new BadRequestException(
        payout.status === "sending" ? "That payout is already on its way."
        : payout.status === "paid" ? "That payout has already been paid."
        : "Approve the payout first.",
      );
    }

    const dest = classifyPayoutDestination(payout.destination);
    const problem = payoutDestinationProblem(dest);
    if (problem) throw new BadRequestException(problem);

    await this.assertWalletCanCover(payout.amount_cents);

    // Claim it. `status=eq.approved` in the filter is the lock: whoever writes
    // second gets no rows back and stops here rather than paying again.
    const claimed = await this.patch<PayoutRow[]>(
      `provider_payouts?id=eq.${encodeURIComponent(id)}&status=eq.approved`,
      { status: "sending", send_error: null, decided_by: adminId, decided_at: new Date().toISOString() },
    );
    if (!claimed?.length) throw new BadRequestException("That payout is already on its way.");

    return this.dispatch(claimed[0]);
  }

  /**
   * Pay a row that has already been claimed as `sending`, and land it.
   *
   * Both ways to a payment end here — an admin pressing Send, and a provider
   * withdrawing straight from their own screen — so there is one description
   * of what SUCCESS, PENDING and failure each mean, rather than two that drift
   * apart the first time one of them is fixed.
   */
  private async dispatch(payout: PayoutRow): Promise<PayoutRow> {
    const id = payout.id;
    const dest = classifyPayoutDestination(payout.destination) as
      { kind: "lightning_address" | "onchain"; value: string };

    const memo = `EverySub payout ${id.slice(0, 8)}`;
    let result: { status: string; error: string | null; sentAmount?: number; sentUnit?: string };
    try {
      result = await this.blink.sendPayout({
        destination: dest as { kind: "lightning_address" | "onchain"; value: string },
        amountCents: payout.amount_cents,
        memo,
      });
    } catch (err) {
      // The call itself blew up — a network error, a bad key, Blink down. We
      // do not know whether anything left, so this does NOT go back to
      // approved: a human reads the error and the wallet before retrying.
      const message = err instanceof Error ? err.message : String(err);
      const stuck = await this.finish(id, "failed", { send_error: `Could not reach Blink: ${message}` });
      this.logger.error(`[payout] ${id}: send threw — ${message}`);
      return stuck;
    }

    if (result.status === "SUCCESS") {
      const paid = await this.finish(id, "paid", {
        paid_at: new Date().toISOString(),
        method: dest.kind === "onchain" ? "onchain" : "lightning",
        // Blink's send mutations answer with a status, not a hash. The memo is
        // what ties this row to the entry in the wallet's own history — and
        // the amount in the unit Blink counted goes beside it, because the one
        // time those two disagreed the ledger said $1.00 and 100 sats left.
        reference: result.sentAmount != null
          ? `${memo} · ${result.sentAmount} ${result.sentUnit}`
          : memo,
        send_error: null,
      });
      this.logger.log(`[payout] ${id}: sent ${payout.amount_cents}c via ${dest.kind}`);
      await this.notifyDecision(paid, "paid", null).catch(() => undefined);
      // With no approval step, this is the only moment an admin hears that
      // money left the wallet. Best-effort, like every notification here.
      await this.notifyAdminsOfPayment(paid).catch((err) =>
        this.logger.warn(`[payout] ${id}: could not notify admins — ${String(err)}`));
      return paid;
    }

    if (result.status === "PENDING") {
      this.logger.log(`[payout] ${id}: pending at Blink`);
      return this.finish(id, "sending", {
        method: dest.kind === "onchain" ? "onchain" : "lightning",
        reference: memo,
        send_error: null,
      });
    }

    const reason = result.error
      ?? (result.status === "ALREADY_PAID" ? "Blink says this was already paid." : "Blink refused the payment.");
    this.logger.warn(`[payout] ${id}: ${result.status} — ${reason}`);
    const failed = await this.finish(id, "failed", { send_error: reason });
    await this.notifyDecision(failed, "failed", reason).catch(() => undefined);
    return failed;
  }

  /** Land a payout in its final state. Separate so every exit writes the same shape. */
  private async finish(id: string, status: string, extra: Record<string, unknown>): Promise<PayoutRow> {
    const updated = await this.patch<PayoutRow[]>(
      `provider_payouts?id=eq.${encodeURIComponent(id)}`,
      { status, ...extra },
    );
    const row = updated?.[0];
    if (!row) throw new NotFoundException("Payout not found.");
    return row;
  }

  /**
   * Draw a line: everything earned up to now has already been settled.
   *
   * This platform started paying providers before it could pay them. All of
   * that money has changed hands outside the system, so on the day the send
   * button appeared every business was owed its entire history over again —
   * `available` is all-time earnings minus recorded payouts, and there were no
   * recorded payouts.
   *
   * Rather than a cut-off date bolted onto the revenue query, the settlement
   * is written where every other payment is: one `paid` row for exactly what
   * is outstanding, marked as settled outside the platform. The arithmetic
   * stays "earned minus paid" with nothing special in it, the history says
   * plainly what happened, and tomorrow's newly recognised revenue is the only
   * thing left to withdraw.
   *
   * It stays useful after the one-off, too — a provider paid by hand in cash
   * is the same event, and this is how it gets into the ledger.
   */
  async settle(providerId: string, adminId: string | null, note?: string | null): Promise<PayoutRow> {
    const summary = await this.earnings.summarize(providerId);
    if (summary.availableCents <= 0) {
      throw new BadRequestException("There is nothing outstanding for this business.");
    }

    const row = await this.create({
      providerId,
      amountCents: summary.availableCents,
      method: "settlement",
      reference: "settled-outside-platform",
      note: note?.trim()
        || "Settled outside the platform — everything earned up to this date was already paid.",
    }, adminId);

    this.logger.log(`[payout] settled ${summary.availableCents}c for provider ${providerId} by ${adminId ?? "unknown"}`);
    return row;
  }

  /**
   * What settling would record, without recording it.
   *
   * An admin about to write a payment into the ledger should see the figure
   * first, per business, and see it come from the same calculation the button
   * will use rather than from a screen that might be a minute stale.
   */
  async outstanding(): Promise<Array<{ providerId: string; name: string; availableCents: number; commissionPct: number }>> {
    const providers = await this.rest<Array<{ id: string; name: string; status: string | null }>>(
      `providers?select=id,name,status&order=name`,
    );
    const out: Array<{ providerId: string; name: string; availableCents: number; commissionPct: number }> = [];
    for (const p of providers ?? []) {
      const summary = await this.earnings.summarize(p.id);
      if (summary.availableCents > 0) {
        out.push({
          providerId: p.id,
          name: p.name,
          availableCents: summary.availableCents,
          commissionPct: summary.commissionPct,
        });
      }
    }
    return out;
  }

  /** Every open request across all providers — the admin's queue. */
  async pendingRequests(): Promise<PayoutRow[]> {
    const rows = await this.rest<PayoutRow[]>(
      `provider_payouts?status=in.(requested,approved)&select=*&order=requested_at.desc`,
    );
    return rows ?? [];
  }

  /** Payouts for one provider, newest first. Throws unless the caller owns it. */
  async listForOwner(userId: string, providerId: string, isAdmin = false): Promise<PayoutRow[]> {
    await this.assertOwner(userId, providerId, isAdmin);
    return this.list(providerId);
  }

  async list(providerId: string): Promise<PayoutRow[]> {
    const rows = await this.rest<PayoutRow[]>(
      `provider_payouts?provider_id=eq.${encodeURIComponent(providerId)}` +
        `&select=*&order=created_at.desc`,
    );
    return rows ?? [];
  }

  async create(input: CreatePayoutInput, createdBy: string | null): Promise<PayoutRow> {
    const amount = Math.round(Number(input.amountCents));
    if (!Number.isFinite(amount) || amount <= 0) {
      throw new BadRequestException("A payout amount must be a positive number of cents.");
    }
    if (input.periodStart && input.periodEnd && input.periodEnd < input.periodStart) {
      throw new BadRequestException("The period ends before it starts.");
    }

    const created = await this.post<PayoutRow[]>("provider_payouts", {
      provider_id: input.providerId,
      amount_cents: amount,
      period_start: input.periodStart || null,
      period_end: input.periodEnd || null,
      method: input.method || null,
      reference: input.reference || null,
      note: input.note || null,
      paid_at: input.paidAt || new Date().toISOString(),
      created_by: createdBy,
    });
    const row = created?.[0];
    if (!row) throw new BadRequestException("The payout could not be recorded.");
    this.logger.log(`[payout] +${amount} to provider ${input.providerId} by ${createdBy ?? "unknown"}`);
    return row;
  }

  async remove(id: string): Promise<{ ok: true }> {
    await this.del(`provider_payouts?id=eq.${encodeURIComponent(id)}`);
    this.logger.log(`[payout] removed ${id}`);
    return { ok: true };
  }

  /**
   * Tell the admins a provider is waiting to be paid.
   *
   * The provider is promised "you'll be notified once it's sent", and that
   * promise only worked in one direction: a request landed in the queue and
   * nothing said so, so it was seen whenever somebody happened to open
   * Finance. Best-effort, like every other notification here — a payout
   * request is recorded whether or not anyone could be told about it.
   */
  private async notifyAdminsOfRequest(row: PayoutRow): Promise<void> {
    await this.notifyAdmins(row, {
      type: "payout_requested",
      title: "Payout requested",
      body: (name, dollars) => `${name} asked to withdraw ${dollars}.`,
    });
  }

  private async notifyAdmins(
    row: PayoutRow,
    copy: { type: string; title: string; body: (name: string, dollars: string) => string },
  ): Promise<void> {
    const [provider, admins] = await Promise.all([
      this.rest<Array<{ name: string }>>(
        `providers?id=eq.${encodeURIComponent(row.provider_id)}&select=name&limit=1`,
      ),
      this.rest<Array<{ user_id: string }>>(
        `user_roles?select=user_id,roles!inner(name)&roles.name=in.(admin,super_admin)`,
      ),
    ]);
    const name = provider?.[0]?.name ?? "A business";
    const recipients = [...new Set((admins ?? []).map((r) => String(r.user_id)).filter(Boolean))];
    if (!recipients.length) return;

    const dollars = `$${(row.amount_cents / 100).toFixed(2)}`;
    await Promise.all(recipients.map((recipient) => this.post("user_notifications", {
      recipient_user_id: recipient,
      category: "payout",
      type: copy.type,
      title: copy.title,
      body: copy.body(name, dollars),
      related_entity_type: "provider_payout",
      related_entity_id: row.id,
      action_url: "/admin/payments",
    })));
  }

  /** Tell the admins money left the wallet. */
  private async notifyAdminsOfPayment(row: PayoutRow): Promise<void> {
    await this.notifyAdmins(row, {
      type: "payout_sent",
      title: "Payout sent",
      body: (name, dollars) => `${dollars} went to ${name}.`,
    });
  }

  /**
   * Tell the owner. Best-effort by design: a notification that fails to send
   * must not roll back a decision an admin has already made.
   */
  private async notifyDecision(row: PayoutRow, decision: string, note: string | null): Promise<void> {
    const provider = await this.rest<Array<{ admin_user_id: string | null; name: string }>>(
      `providers?id=eq.${encodeURIComponent(row.provider_id)}&select=admin_user_id,name&limit=1`,
    );
    const ownerId = provider?.[0]?.admin_user_id;
    if (!ownerId) return;

    const dollars = `$${(row.amount_cents / 100).toFixed(2)}`;
    const copy =
      decision === "paid"     ? { title: "Payout sent", body: `${dollars} is on its way to you.` }
      : decision === "approved" ? { title: "Payout approved", body: `${dollars} was approved and will be sent shortly.` }
      // A send that did not go through is not a refusal, and telling a provider
      // they were "declined" when the wallet simply could not route would be a
      // lie they would act on. The money is back in their balance.
      : decision === "failed" ? {
          title: "Payout could not be sent",
          body: `${dollars} did not go through and is available again.${note ? ` ${note}` : ""}`,
        }
      : { title: "Payout declined", body: `Your ${dollars} request was declined.${note ? ` ${note}` : ""}` };

    await this.post("user_notifications", {
      recipient_user_id: ownerId,
      category: "payout",
      type: `payout_${decision}`,
      title: copy.title,
      body: copy.body,
      related_entity_type: "provider_payout",
      related_entity_id: row.id,
      action_url: `/my-provider/${row.provider_id}`,
    });
  }

  private async assertOwner(userId: string, providerId: string, isAdmin: boolean): Promise<void> {
    if (isAdmin) return;
    const rows = await this.rest<Array<{ admin_user_id: string | null }>>(
      `providers?id=eq.${encodeURIComponent(providerId)}&select=admin_user_id&limit=1`,
    );
    const row = rows?.[0];
    if (!row) throw new NotFoundException("Provider not found.");
    if (!row.admin_user_id || String(row.admin_user_id) !== String(userId)) {
      throw new ForbiddenException("You don't own this business.");
    }
  }

  // ─── Supabase REST (service role — this table is invisible to the anon key) ──

  private restBase(): { base: string; key: string } {
    const base = this.config.get<string>("SUPABASE_URL")?.replace(/\/$/, "");
    const key = this.config.get<string>("SUPABASE_SERVICE_ROLE_KEY");
    if (!base || !key) {
      // The anon key would silently return an empty list here rather than fail,
      // which reads as "no payouts" — say it out loud instead.
      throw new Error("provider_payouts needs SUPABASE_SERVICE_ROLE_KEY; the anon key cannot see this table.");
    }
    return { base, key };
  }

  private headers(extra: Record<string, string> = {}) {
    const { key } = this.restBase();
    return { apikey: key, Authorization: `Bearer ${key}`, ...extra };
  }

  private async rest<T>(path: string): Promise<T | null> {
    const { base } = this.restBase();
    const res = await fetch(`${base}/rest/v1/${path}`, { headers: this.headers() });
    if (!res.ok) return null;
    return (await res.json()) as T;
  }

  private async post<T>(path: string, body: Record<string, unknown>): Promise<T | null> {
    const { base } = this.restBase();
    const res = await fetch(`${base}/rest/v1/${path}`, {
      method: "POST",
      headers: this.headers({ "Content-Type": "application/json", Prefer: "return=representation" }),
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new BadRequestException(`Payout insert failed (${res.status}): ${text}`);
    }
    return (await res.json()) as T;
  }

  private async patch<T>(path: string, body: Record<string, unknown>): Promise<T | null> {
    const { base } = this.restBase();
    const res = await fetch(`${base}/rest/v1/${path}`, {
      method: "PATCH",
      headers: this.headers({ "Content-Type": "application/json", Prefer: "return=representation" }),
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new BadRequestException(`Payout update failed (${res.status}): ${text}`);
    }
    return (await res.json()) as T;
  }

  private async del(path: string): Promise<void> {
    const { base } = this.restBase();
    const res = await fetch(`${base}/rest/v1/${path}`, { method: "DELETE", headers: this.headers() });
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new BadRequestException(`Payout delete failed (${res.status}): ${text}`);
    }
  }
}
