import { Body, Controller, Get, Param, Post, Req, UseGuards } from "@nestjs/common";
import { ApiBearerAuth, ApiBody, ApiOperation, ApiProperty, ApiResponse, ApiTags } from "@nestjs/swagger";
import { IsIn, IsInt, IsString, IsUUID, Min } from "class-validator";
import { AccountAuthGuard, type AccountRequest } from "../account/account-auth.guard";
import { FoodService } from "./food.service";
import type { RenewalPaymentMethod } from "../payments/subscription-renewal.service";

/**
 * Payload for /renew. Every field is required — the verify step needs the
 * reference; the audit row needs amount + idempotency key.
 */
class RenewSubscriptionDto {
  @ApiProperty({ enum: ["lightning", "onchain", "crypto", "infinita", "paypal"], example: "lightning" })
  @IsIn(["lightning", "onchain", "crypto", "infinita", "paypal"])
  payment_method!: RenewalPaymentMethod;

  @ApiProperty({ example: "abc123deadbeef" })
  @IsString()
  payment_reference!: string;

  @ApiProperty({ minimum: 1, example: 5400 })
  @IsInt()
  @Min(0)
  amount_cents!: number;

  @ApiProperty({ description: "Client-generated UUID; retries with the same key are safe.", example: "550e8400-e29b-41d4-a716-446655440000" })
  @IsUUID()
  idempotency_key!: string;
}

@ApiTags("Food")
@ApiBearerAuth()
@UseGuards(AccountAuthGuard)
@Controller("account/food/subscriptions")
export class FoodController {
  constructor(private readonly food: FoodService) {}

  @ApiOperation({ summary: "Get a food subscription with a server-enforced access decision + this week's menu" })
  @ApiResponse({ status: 200, description: "Access decision; menu included only when access is granted." })
  @Get(":id")
  getAccess(@Param("id") id: string, @Req() req: AccountRequest) {
    return this.food.getSubscriptionAccess(req.authUser!.id, id);
  }

  @ApiOperation({
    summary: "Renew a food subscription — verified payment + idempotent",
    description:
      "Requires payment_method + payment_reference which the server verifies with the actual provider (Blink / SimpleFi / PayPal). Same idempotency_key is a safe no-op. Emits an audit row in subscription_renewals.",
  })
  @ApiBody({ type: RenewSubscriptionDto })
  @ApiResponse({ status: 201, description: "Renewed; returns new start/end dates + idempotent flag." })
  @Post(":id/renew")
  renew(@Param("id") id: string, @Body() body: RenewSubscriptionDto, @Req() req: AccountRequest) {
    return this.food.renewSubscription(req.authUser!.id, id, body);
  }
}
