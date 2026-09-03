import { Module } from "@nestjs/common";
import { AuthModule } from "../auth/auth.module";
import { PaymentsModule } from "../payments/payments.module";
import { AccountAuthGuard } from "../account/account-auth.guard";
import { RentalsController } from "./rentals.controller";
import { RentalsService } from "./rentals.service";

@Module({
  imports: [AuthModule, PaymentsModule],
  controllers: [RentalsController],
  providers: [RentalsService, AccountAuthGuard],
})
export class RentalsModule {}
