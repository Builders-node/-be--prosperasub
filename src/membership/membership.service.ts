import { Inject, Injectable } from "@nestjs/common";
import { SUBSCRIPTION_SOURCE, type SubscriptionSource } from "./subscription-source.port";
import type { AccessDecision } from "./subscription-view";

/**
 * Membership domain — the Policy Decision Point (PDP). The single authority for
 * "can this subject access the platform?" across every other domain. Today the
 * rule is: permit if the subject has any active subscription. As entitlements /
 * credits / trials land, this method grows richer (and gains real use of
 * `action` / `resourceRef`) without any caller changing.
 */
@Injectable()
export class MembershipService {
  constructor(@Inject(SUBSCRIPTION_SOURCE) private readonly source: SubscriptionSource) {}

  async evaluateAccess(subjectId: string, _action?: string, _resourceRef?: string): Promise<AccessDecision> {
    const subscriptions = await this.source.getSubscriptions(subjectId);
    const activeCount = subscriptions.filter((s) => s.status === "active").length;
    const permit = activeCount > 0;
    const reason = permit
      ? `${activeCount} active subscription${activeCount === 1 ? "" : "s"}`
      : subscriptions.length === 0
        ? "No subscriptions on file"
        : "No active subscriptions";
    return { permit, reason, activeCount, subscriptions };
  }
}
