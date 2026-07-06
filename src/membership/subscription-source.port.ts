import type { SubscriptionView } from "./subscription-view";

/**
 * Port: where the Membership domain gets a subject's subscriptions. The domain
 * depends only on this contract; an ACL implements it over whatever store holds
 * the data (today: the legacy per-service tables; later: an entitlement model).
 */
export const SUBSCRIPTION_SOURCE = Symbol("SUBSCRIPTION_SOURCE");

export interface SubscriptionSource {
  getSubscriptions(subjectId: string): Promise<SubscriptionView[]>;
}
