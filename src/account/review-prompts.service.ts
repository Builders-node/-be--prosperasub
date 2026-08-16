import { Injectable, Logger } from "@nestjs/common";

/**
 * What this customer could rate, and has not.
 *
 * The platform has had a rating widget on every subscription card for months
 * and exactly one review to show for it. Nothing ever asked: the stars sat
 * inside a card the customer opens when something is wrong, not after a job
 * went well.
 *
 * This answers "what did we just do for you?" — a visit, a delivery or a
 * booked hour that finished recently, for a business you have not rated. It
 * reads `service_occurrences`, which is the one table that knows a job
 * actually happened, whatever the service; that table is service-role only,
 * which is why this lives on the server.
 */

export interface ReviewPrompt {
  occurrenceId: string;
  providerId: string;
  providerName: string;
  /** cleaning | food | beach — what the review is tagged as. */
  service: string;
  /** "Lunch", "Tennis Court 1" — whatever the occurrence was, when it says. */
  itemLabel: string | null;
  /** When the job finished, ISO. */
  happenedAt: string;
  subscriptionId: string | null;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** How far back a finished job is still worth asking about. */
const WINDOW_DAYS = 30;

@Injectable()
export class ReviewPromptsService {
  private readonly logger = new Logger(ReviewPromptsService.name);

  async pending(userId: string): Promise<ReviewPrompt[]> {
    // `service_occurrences.user_id` is a uuid column, so a Google-sub id can
    // never match one — asking anyway would return every row in the table.
    if (!UUID_RE.test(userId)) return [];

    const since = new Date(Date.now() - WINDOW_DAYS * 86_400_000).toISOString();
    const [occurrences, reviews] = await Promise.all([
      this.rest<Array<Record<string, any>>>(
        `service_occurrences?user_id=eq.${this.enc(userId)}&status=eq.done` +
        `&starts_at=gte.${this.enc(since)}` +
        `&select=id,provider_id,source_service_key,source_subscription_id,item_key,starts_at` +
        `&order=starts_at.desc&limit=100`,
      ),
      this.rest<Array<{ provider_id: string }>>(
        `provider_reviews?user_id=eq.${this.enc(userId)}&select=provider_id`,
      ),
    ]);

    const rated = new Set((reviews ?? []).map((r) => String(r.provider_id)));
    // One ask per business, about the most recent thing it did. Five rows for
    // five meals last week is not five questions.
    const byProvider = new Map<string, Record<string, any>>();
    (occurrences ?? []).forEach((o) => {
      const pid = String(o.provider_id ?? "");
      if (!pid || rated.has(pid) || byProvider.has(pid)) return;
      byProvider.set(pid, o);
    });
    if (!byProvider.size) return [];

    const ids = [...byProvider.keys()];
    const providers = await this.rest<Array<{ id: string; name: string; archetype_key: string | null }>>(
      `providers?id=in.(${ids.join(",")})&select=id,name,archetype_key`,
    );
    const names = new Map((providers ?? []).map((p) => [String(p.id), p.name]));

    return [...byProvider.entries()].map(([pid, o]) => ({
      occurrenceId: String(o.id),
      providerId: pid,
      providerName: names.get(pid) ?? "this business",
      service: String(o.source_service_key ?? "cleaning"),
      itemLabel: o.item_key ?? null,
      happenedAt: String(o.starts_at),
      subscriptionId: o.source_subscription_id ? String(o.source_subscription_id) : null,
    }));
  }

  // ─── Supabase REST (service role — occurrences are invisible to anon) ───────

  private enc(value: string) { return encodeURIComponent(value); }

  private async rest<T>(path: string): Promise<T | null> {
    const base = process.env.SUPABASE_URL?.replace(/\/$/, "");
    const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
    if (!base || !key) return null;
    try {
      const res = await fetch(`${base}/rest/v1/${path}`, {
        headers: { apikey: key, Authorization: `Bearer ${key}` },
      });
      if (!res.ok) {
        this.logger.warn(`[review-prompts] ${path} → ${res.status}`);
        return null;
      }
      return (await res.json()) as T;
    } catch (err) {
      // A prompt is a nicety: if it cannot be built, the page shows nothing
      // rather than an error where an invitation should be.
      this.logger.warn(`[review-prompts] ${path} failed: ${String(err)}`);
      return null;
    }
  }
}
