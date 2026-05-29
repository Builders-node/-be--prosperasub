import { Module } from "@nestjs/common";
import { SessionService } from "../auth/session.service";
import { MailController } from "./mail.controller";
import { MailService } from "./mail.service";

@Module({
  controllers: [MailController],
  providers: [MailService, SessionService],
  exports: [MailService]
})
export class MailModule {}
