import { Module } from "@nestjs/common";
import { AuthModule } from "../auth/auth.module";
import { AccountAuthGuard } from "../account/account-auth.guard";
import { OrderController } from "./order.controller";
import { OrderService } from "./order.service";
import { OrderSaga } from "./order.saga";

/**
 * Order domain (Phase 5) — the saga hub. `OrderSaga` self-registers on the event
 * bus and drives orders from Billing events; `order.OrderConfirmed` fans out to
 * Booking/Membership. Prisma + EventBus are global; AuthModule guards placement.
 */
@Module({
  imports: [AuthModule],
  controllers: [OrderController],
  providers: [OrderService, OrderSaga, AccountAuthGuard],
  exports: [OrderService],
})
export class OrderModule {}
