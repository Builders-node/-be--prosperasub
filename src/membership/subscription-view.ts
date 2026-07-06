/**
 * Membership domain — generic, industry-agnostic views. `service` is a free
 * string (produced by the ACL) so the domain never enumerates industries.
 */

export type AccessStatus = "active" | "trial" | "pending" | "expired" | "canceled";

export interface SubscriptionView {
  id: string;
  service: string;                 // "cleaning" | "food" | … — data, not a domain enum
  name: string;
  status: AccessStatus;
  expires_at: string | null;
}

/** The Policy Decision Point result. */
export interface AccessDecision {
  permit: boolean;
  reason: string;
  activeCount: number;
  subscriptions: SubscriptionView[];
}
