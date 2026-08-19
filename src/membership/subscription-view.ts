/**
 * Membership domain — generic, industry-agnostic views. `service` is a free
 * string (produced by the ACL) so the domain never enumerates industries.
 */

export type AccessStatus = "active" | "trial" | "pending" | "expired" | "canceled";

export interface SubscriptionView {
  id: string;
  service: string;                 // "cleaning" | "food" | … — data, not a domain enum
  name: string;                    // the tariff/plan name — the headline
  status: AccessStatus;
  expires_at: string | null;
  provider_name?: string | null;   // the business behind the plan (verify page subtitle)
  image_url?: string | null;       // provider avatar/photo for the verify-page thumbnail
}

/** The Policy Decision Point result. */
export interface AccessDecision {
  permit: boolean;
  reason: string;
  activeCount: number;
  subscriptions: SubscriptionView[];
}
