import { Module } from "@nestjs/common";
import { SessionService } from "../auth/session.service";
import { MailController } from "./mail.controller";
import { MailService } from "./mail.service";
import { ProviderOrderMailService } from "./provider-order-mail.service";

@Module({
  controllers: [MailController],
  providers: [MailService, ProviderOrderMailService, SessionService],
  // Exported so the reconcile cron can notify when a payment lands later.
  exports: [MailService, ProviderOrderMailService]
})
export class MailModule {}
