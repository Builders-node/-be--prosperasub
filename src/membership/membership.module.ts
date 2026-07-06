import { Global, Module } from "@nestjs/common";
import { MembershipService } from "./membership.service";
import { LegacySubscriptionSource } from "./legacy-subscriptions.acl";
import { MembershipEventHandler } from "./membership-events.handler";
import { SUBSCRIPTION_SOURCE } from "./subscription-source.port";

/**
 * Membership domain (Phase 2). Global so any domain can inject `MembershipService`
 * and call `evaluateAccess` — the single access-control authority. The
 * subscription source is bound to the legacy ACL for now; swap it here when the
 * entitlement read model lands.
 */
@Global()
@Module({
  providers: [
    MembershipService,
    LegacySubscriptionSource,
    MembershipEventHandler,
    { provide: SUBSCRIPTION_SOURCE, useExisting: LegacySubscriptionSource },
  ],
  exports: [MembershipService],
})
export class MembershipModule {}
