import { Module } from "@nestjs/common";
import { BlinkService } from "./blink.service";
import { PaymentsController } from "./payments.controller";

@Module({
  controllers: [PaymentsController],
  providers: [BlinkService]
})
export class PaymentsModule {}
