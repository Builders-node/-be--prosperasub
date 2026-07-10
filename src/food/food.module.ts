import { Module } from "@nestjs/common";
import { AuthModule } from "../auth/auth.module";
import { PaymentsModule } from "../payments/payments.module";
import { AccountAuthGuard } from "../account/account-auth.guard";
import { FoodController } from "./food.controller";
import { FoodService } from "./food.service";

@Module({
  imports: [AuthModule, PaymentsModule],
  controllers: [FoodController],
  providers: [FoodService, AccountAuthGuard],
  exports: [FoodService],
})
export class FoodModule {}
