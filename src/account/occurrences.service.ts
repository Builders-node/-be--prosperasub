import { BadRequestException, ForbiddenException, Injectable, Logger, NotFoundException } from "@nestjs/common";

/**
 * The provider's day, whatever they sell.
 *
 * A cleaning visit, a meal delivery and an hour on a court are the same thing
 * — an occurrence — and used to be three tables, three screens and three sets
 * of verbs. This serves the one table behind all of them.
 *
 * Two rules hold the migration together while both models run:
 *
 * 1. **Legacy still owns what it already owned.** Marking a delivery writes
 *    `food_delivery_logs`; marking a visit writes `cleaning_bookings`. The DB
 *    trigger carries the change into the occurrence. One writer per fact, so
 *    the two cannot drift.
 * 2. **Except where legacy has nothing.** A *scheduled* food delivery exists
 *    only here — `food_delivery_logs` records what already happened — so its
 *    time is written here and nowhere else. That absence is precisely why food
 *    has never had a reschedule.
 *
 * The table is service-role only (RLS on, no policies): it carries home
 * addresses and "key under the mat". Everything below goes through an
 * ownership check first.
 */

export interface OccurrenceRow {
  id: string;
  provider_id: string;
  source_service_key: string | null;
  source_record_id: string | null;
  source_subscription_id: string | null;
  item_key: string | null;
  starts_at: string;
  ends_at: string | null;
  status: string;
  status_reason: string | null;
  assignee: string | null;
  notes: string | null;
  access_instructions: string | null;
  completion: Record<string, unknown> | null;
  user_id: string | null;
  slot_id: string | null;
  /**
   * Who the work is for — resolved from `user_id`, not stored.
   *
   * The day's list showed a time, a court and a status, and the one question
   * the person doing the work asks — "whose is this?" — could only be answered
   * by leaving for the customer list and matching by time. It travels with the
   * row now; the table itself keeps holding only the id.
   */
  customer_name?: string | null;
  customer_email?: string | null;
}

const STATUSES = ["scheduled", "done", "failed", "cancelled", "rescheduled"] as const;
type Status = (typeof STATUSES)[number];

/** What the booking engine calls the same states on its own row. */
const BOOKING_STATUS: Partial<Record<Status, string>> = {
  scheduled: "confirmed",
  done: "completed",
  failed: "no_show",
  cancelled: "cancelled",
};

/** What each service calls a finished occurrence in its own table. */
const LEGACY_STATUS: Record<string, Partial<Record<Status, string>>> = {
  food:     { done: "delivered", failed: "failed", cancelled: "cancelled", scheduled: "pending" },
  cleaning: { done: "completed", failed: "no_show", cancelled: "cancelled", scheduled: "booked" },
  beach:    { done: "completed", failed: "cancelled", cancelled: "cancelled", scheduled: "booked" },
};

@Injectable()
export class OccurrencesService {
  private readonly logger = new Logger(OccurrencesService.name);

  /** A provider's occurrences in a window, newest day first. */
  async list(userId: string, providerId: string, isAdmin: boolean, query: {
    from?: string; to?: string; status?: string;
  }): Promise<OccurrenceRow[]> {
    await this.assertOwner(userId, providerId, isAdmin);

    const filters = [`provider_id=eq.${encodeURIComponent(providerId)}`];
    if (query.from) filters.push(`starts_at=gte.${encodeURIComponent(query.from)}`);
    if (query.to)   filters.push(`starts_at=lte.${encodeURIComponent(query.to)}`);
    if (query.status && query.status !== "all") {
      filters.push(`status=eq.${encodeURIComponent(query.status)}`);
    }
    const rows = await this.rest<OccurrenceRow[]>(
      `service_occurrences?${filters.join("&")}&select=*&order=starts_at.asc&limit=2000`,
    );
    return this.withCustomers(rows ?? []);
  }

  /**
   * Mark it done, failed, cancelled — or back to scheduled.
   *
   * Writes the legacy row where one exists and lets the trigger carry it here,
   * so the provider's older screens and this one can never disagree.
   */
  async setStatus(userId: string, occurrenceId: string, isAdmin: boolean, input: {
    status: string; reason?: string | null;
  }): Promise<OccurrenceRow> {
    const occ = await this.load(occurrenceId);
    await this.assertOwner(userId, occ.provider_id, isAdmin);

    if (!STATUSES.includes(input.status as Status)) {
      throw new BadRequestException(`Unknown status "${input.status}".`);
    }
    const status = input.status as Status;
    const svc = occ.source_service_key ?? "";
    const legacyStatus = LEGACY_STATUS[svc]?.[status];

    if (svc === "food") {
      // A delivery's legacy row is the LOG, and a scheduled delivery has none
      // yet — so marking one creates it, and the trigger adopts this row
      // rather than making a second.
      await this.upsertFoodLog(occ, status, input.reason ?? null);
      return this.load(occurrenceId);
    }

    if (svc === "cleaning" && occ.source_record_id && legacyStatus) {
      await this.patch(`cleaning_bookings?id=eq.${this.enc(occ.source_record_id)}`, {
        status: legacyStatus,
        updated_at: new Date().toISOString(),
      });
      return this.load(occurrenceId);
    }

    // The beach's twin is the engine's `bookings` row — that is where the hour
    // is actually held, so marking it here has to write there or the court
    // stays booked for a session the provider just cancelled. The mirror
    // trigger carries the change back into this occurrence.
    if (svc === "beach" && occ.source_record_id) {
      const bookingStatus = BOOKING_STATUS[status];
      if (bookingStatus) {
        await this.patch(`bookings?id=eq.${this.enc(occ.source_record_id)}`, {
          status: bookingStatus,
          updated_at: new Date().toISOString(),
        });
        return this.load(occurrenceId);
      }
    }

    // No legacy twin (a generated occurrence for a service that has none).
    await this.patch(`service_occurrences?id=eq.${this.enc(occurrenceId)}`, {
      status, status_reason: input.reason ?? null, updated_at: new Date().toISOString(),
    });
    return this.load(occurrenceId);
  }

  /** Who is doing it, and anything the provider wants written on it. */
  async annotate(userId: string, occurrenceId: string, isAdmin: boolean, input: {
    assignee?: string | null; notes?: string | null;
  }): Promise<OccurrenceRow> {
    const occ = await this.load(occurrenceId);
    await this.assertOwner(userId, occ.provider_id, isAdmin);

    // Cleaning keeps the assignee on its own row, and the trigger mirrors it.
    if (occ.source_service_key === "cleaning" && occ.source_record_id) {
      await this.patch(`cleaning_bookings?id=eq.${this.enc(occ.source_record_id)}`, {
        ...(input.assignee !== undefined ? { assigned_cleaner: input.assignee } : {}),
        ...(input.notes !== undefined ? { notes: input.notes } : {}),
        updated_at: new Date().toISOString(),
      });
      return this.load(occurrenceId);
    }

    await this.patch(`service_occurrences?id=eq.${this.enc(occurrenceId)}`, {
      ...(input.assignee !== undefined ? { assignee: input.assignee } : {}),
      ...(input.notes !== undefined ? { notes: input.notes } : {}),
      updated_at: new Date().toISOString(),
    });
    return this.load(occurrenceId);
  }

  /**
   * Move it.
   *
   * Only where the occurrence does not hold a capacity slot: a cleaning visit
   * reserves one, and releasing the old slot plus claiming the new one is the
   * existing reschedule endpoint's job, not a second implementation here.
   * Deliveries hold no slot, which is what makes this the first reschedule
   * food has ever had.
   */
  async reschedule(userId: string, occurrenceId: string, isAdmin: boolean, startsAt: string): Promise<OccurrenceRow> {
    const occ = await this.load(occurrenceId);
    await this.assertOwner(userId, occ.provider_id, isAdmin);

    if (occ.slot_id) {
      throw new BadRequestException(
        "This visit holds a booked time slot — move it from the booking screen so the slot is released.",
      );
    }
    const when = new Date(startsAt);
    if (Number.isNaN(when.getTime())) throw new BadRequestException("That is not a date.");

    await this.patch(`service_occurrences?id=eq.${this.enc(occurrenceId)}`, {
      starts_at: when.toISOString(),
      status: occ.status === "scheduled" ? "scheduled" : occ.status,
      updated_at: new Date().toISOString(),
    });

    // A delivery already marked in the legacy log moves there too, so the day
    // it is filed under matches the day it now happens.
    if (occ.source_service_key === "food" && occ.source_record_id) {
      await this.patch(`food_delivery_logs?id=eq.${this.enc(occ.source_record_id)}`, {
        delivery_date: when.toISOString().slice(0, 10),
        updated_at: new Date().toISOString(),
      });
    }
    return this.load(occurrenceId);
  }

  /** The report a cleaner leaves behind — now available to every service. */
  async complete(userId: string, occurrenceId: string, isAdmin: boolean, input: {
    checklist?: unknown; photoUrl?: string | null; issue?: string | null; completedBy?: string | null;
  }): Promise<OccurrenceRow> {
    const occ = await this.load(occurrenceId);
    await this.assertOwner(userId, occ.provider_id, isAdmin);

    await this.patch(`service_occurrences?id=eq.${this.enc(occurrenceId)}`, {
      completion: {
        checklist: input.checklist ?? null,
        photo_url: input.photoUrl ?? null,
        issue: input.issue ?? null,
        completed_by: input.completedBy ?? null,
        completed_at: new Date().toISOString(),
      },
      updated_at: new Date().toISOString(),
    });
    return this.setStatus(userId, occurrenceId, isAdmin, { status: "done" });
  }

  /** Fill in the days ahead that nobody has scheduled yet. */
  async generate(userId: string, providerId: string, isAdmin: boolean, daysAhead = 21): Promise<{ created: number }> {
    await this.assertOwner(userId, providerId, isAdmin);
    const created = await this.rpc<number>("generate_food_occurrences", { p_days_ahead: daysAhead });
    return { created: Number(created ?? 0) };
  }

  // ─── Legacy writes ──────────────────────────────────────────────────────────

  private async upsertFoodLog(occ: OccurrenceRow, status: Status, reason: string | null): Promise<void> {
    const legacyStatus = LEGACY_STATUS.food[status] ?? "pending";
    const day = new Date(occ.starts_at).toISOString().slice(0, 10);

    if (occ.source_record_id) {
      await this.patch(`food_delivery_logs?id=eq.${this.enc(occ.source_record_id)}`, {
        status: legacyStatus, reason, updated_at: new Date().toISOString(),
      });
      return;
    }

    // The provider row on the log is the LEGACY food_providers id, not the
    // universal one this occurrence carries.
    const providers = await this.rest<Array<{ source_provider_id: string | null }>>(
      `providers?id=eq.${this.enc(occ.provider_id)}&select=source_provider_id`,
    );
    const legacyProvider = providers?.[0]?.source_provider_id;
    if (!legacyProvider || !occ.source_subscription_id) {
      throw new BadRequestException("This delivery has no restaurant record to file against.");
    }

    await this.post("food_delivery_logs", {
      subscription_id: occ.source_subscription_id,
      provider_id: legacyProvider,
      delivery_date: day,
      meal_type: occ.item_key,
      status: legacyStatus,
      reason,
    });
  }

  /**
   * Names for the rows' customers, in one query.
   *
   * Best effort: an occurrence generated before anybody signed in, or one for a
   * walk-in, simply has no name and the screen says so rather than inventing
   * one.
   */
  private async withCustomers(rows: OccurrenceRow[]): Promise<OccurrenceRow[]> {
    const ids = [...new Set(rows.map((r) => r.user_id).filter((id): id is string => !!id))];
    if (!ids.length) return rows;

    const users = await this.rest<Array<{ id: string; name: string | null; display_name: string | null; email: string | null }>>(
      `users?select=id,name,display_name,email&id=in.(${ids.map((i) => this.enc(i)).join(",")})`,
    );
    const byId = new Map((users ?? []).map((u) => [u.id, u]));
    return rows.map((r) => {
      const u = r.user_id ? byId.get(r.user_id) : null;
      return {
        ...r,
        customer_name: u ? (u.display_name || u.name || u.email || null) : null,
        customer_email: u?.email ?? null,
      };
    });
  }

  // ─── Access ─────────────────────────────────────────────────────────────────

  private async load(id: string): Promise<OccurrenceRow> {
    const rows = await this.rest<OccurrenceRow[]>(
      `service_occurrences?id=eq.${this.enc(id)}&select=*&limit=1`,
    );
    const row = rows?.[0];
    if (!row) throw new NotFoundException("That occurrence no longer exists.");
    return row;
  }

  private async assertOwner(userId: string, providerId: string, isAdmin: boolean): Promise<void> {
    if (isAdmin) return;

    const rows = await this.rest<Array<{ id: string; admin_user_id: string | null }>>(
      `providers?id=eq.${this.enc(providerId)}&select=id,admin_user_id&limit=1`,
    );
    const provider = rows?.[0];
    if (!provider) throw new NotFoundException("Provider not found.");

    // A platform-run business has no personal owner — Apartment Cleaning is
    // exactly that. Treating a null owner as "no such provider" locked its own
    // managers out of their day's work, and the screen reported it as an empty
    // day rather than a refusal.
    if (provider.admin_user_id && String(provider.admin_user_id) === String(userId)) return;

    // A manager runs the day-to-day, so they count here.
    const members = await this.rest<Array<{ id: string }>>(
      `provider_members?provider_id=eq.${this.enc(providerId)}&user_id=eq.${this.enc(userId)}&select=id&limit=1`,
    );
    if (!members?.length) throw new ForbiddenException("You don't run this business.");
  }

  // ─── Supabase REST (service role — this table is invisible to the anon key) ──

  private creds() {
    const base = process.env.SUPABASE_URL?.replace(/\/$/, "");
    const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
    if (!base || !key) {
      throw new Error("service_occurrences needs SUPABASE_SERVICE_ROLE_KEY; RLS hides it from the anon key.");
    }
    return { base, key };
  }

  private headers(extra: Record<string, string> = {}) {
    const { key } = this.creds();
    return { apikey: key, Authorization: `Bearer ${key}`, ...extra };
  }

  private enc(value: string) { return encodeURIComponent(value); }

  private async rest<T>(path: string): Promise<T | null> {
    const { base } = this.creds();
    const res = await fetch(`${base}/rest/v1/${path}`, { headers: this.headers() });
    if (!res.ok) {
      // Loudly. A swallowed read here reaches the provider as "nothing on this
      // day", which is indistinguishable from a quiet day and sends them
      // looking for work that the screen simply failed to fetch.
      const text = await res.text().catch(() => "");
      this.logger.error(`[occurrences] GET ${path} → ${res.status}: ${text}`);
      throw new BadRequestException(`Could not read the day's work (${res.status}).`);
    }
    return (await res.json()) as T;
  }

  private async patch(path: string, body: Record<string, unknown>): Promise<void> {
    const { base } = this.creds();
    const res = await fetch(`${base}/rest/v1/${path}`, {
      method: "PATCH",
      headers: this.headers({ "Content-Type": "application/json", Prefer: "return=minimal" }),
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new BadRequestException(`Update failed (${res.status}): ${text}`);
    }
  }

  private async post(path: string, body: Record<string, unknown>): Promise<void> {
    const { base } = this.creds();
    const res = await fetch(`${base}/rest/v1/${path}`, {
      method: "POST",
      headers: this.headers({ "Content-Type": "application/json", Prefer: "return=minimal" }),
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new BadRequestException(`Insert failed (${res.status}): ${text}`);
    }
  }

  private async rpc<T>(fn: string, args: Record<string, unknown>): Promise<T | null> {
    const { base } = this.creds();
    const res = await fetch(`${base}/rest/v1/rpc/${fn}`, {
      method: "POST",
      headers: this.headers({ "Content-Type": "application/json" }),
      body: JSON.stringify(args),
    });
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new BadRequestException(`${fn} failed (${res.status}): ${text}`);
    }
    return (await res.json()) as T;
  }
}
