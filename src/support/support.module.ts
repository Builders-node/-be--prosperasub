import { Module } from "@nestjs/common";
import { AdminSupportController, SupportController } from "./support.controller";
import { SupportService } from "./support.service";
import { MailModule } from "../mail/mail.module";
import { AuthModule } from "../auth/auth.module";
import { AdminModule } from "../admin/admin.module";

@Module({
  imports: [MailModule, AuthModule, AdminModule],
  controllers: [SupportController, AdminSupportController],
  providers: [SupportService],
})
export class SupportModule {}
