import { Module } from "@nestjs/common";
import { AuthModule } from "../auth/auth.module";
import { BookingModule } from "../booking/booking.module";
import { AccountAuthGuard } from "../account/account-auth.guard";
import { VerifyController } from "./verify.controller";
import { VerifyService } from "./verify.service";

@Module({
  imports: [AuthModule, BookingModule],
  controllers: [VerifyController],
  providers: [VerifyService, AccountAuthGuard]
})
export class VerifyModule {}
