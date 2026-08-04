import { Body, Controller, Param, Post, Req, UseGuards } from "@nestjs/common";
import { ApiBearerAuth, ApiBody, ApiOperation, ApiProperty, ApiResponse, ApiTags } from "@nestjs/swagger";
import { IsIn, IsInt, IsOptional, IsString, IsUUID, Min } from "class-validator";
import { AccountAuthGuard, type AccountRequest } from "./account-auth.guard";
import { AccountRenewalsService } from "./account-renewals.service";
import type { RenewalPaymentMethod } from "../payments/subscription-renewal.service";

class RenewPayloadDto {
  @ApiProperty({ enum: ["lightning", "onchain", "crypto", "infinita", "paypal"] })
  @IsIn(["lightning", "onchain", "crypto", "infinita", "paypal"])
  payment_method!: RenewalPaymentMethod;

  @ApiProperty({ example: "abc123deadbeef" })
  @IsString()
  payment_reference!: string;

  @ApiProperty({ minimum: 0, example: 7900 })
  @IsInt()
  @Min(0)
  amount_cents!: number;

  @ApiProperty({
    required: false,
    minimum: 0,
    example: 395,
    description:
      "Payment-method processing fee charged on top of amount_cents. Charged = amount_cents + surcharge_cents. Defaults to 0.",
  })
  @IsOptional()
  @IsInt()
  @Min(0)
  surcharge_cents?: number;

  @ApiProperty({ description: "Client-generated UUID; retries with the same key are safe." })
  @IsUUID()
  idempotency_key!: string;
}

/**
 * User-facing renewal endpoints. All go through SubscriptionRenewalService,
 * which verifies the payment reference with the actual provider before the
 * subscription's period is extended. The idempotency key + audit table
 * prevent duplicate-clicks from double-billing.
 */
@ApiTags("Account renewals")
@ApiBearerAuth()
@UseGuards(AccountAuthGuard)
@Controller("account")
export class AccountRenewalsController {
  constructor(private readonly renewals: AccountRenewalsService) {}

  @ApiOperation({
    summary: "Renew a cleaning subscription — verified payment + idempotent",
    description:
      "Extends the existing cleaning_subscriptions row's period (does NOT create a duplicate). Payment reference is verified against the provider (Blink / SimpleFi / PayPal). Retries with the same idempotency_key are safe no-ops.",
  })
  @ApiBody({ type: RenewPayloadDto })
  @ApiResponse({ status: 201, description: "Renewed; returns new start/end dates + idempotent flag." })
  @Post("cleaning/subscriptions/:id/renew")
  renewCleaning(@Param("id") id: string, @Body() body: RenewPayloadDto, @Req() req: AccountRequest) {
    return this.renewals.renewCleaning(req.authUser!.id, id, body);
  }

  @ApiOperation({
    summary: "Renew a Beach Club membership — verified payment + idempotent",
    description:
      "Extends the existing beach_club_subscriptions row's period, preserving the original duration (or 1 month if the legacy row lacks bounds).",
  })
  @ApiBody({ type: RenewPayloadDto })
  @ApiResponse({ status: 201, description: "Renewed; returns new start/end dates + idempotent flag." })
  @Post("beach/subscriptions/:id/renew")
  renewBeach(@Param("id") id: string, @Body() body: RenewPayloadDto, @Req() req: AccountRequest) {
    return this.renewals.renewBeach(req.authUser!.id, id, body);
  }
}
