import { Body, Controller, Get, HttpCode, Logger, Param, Post, Req } from "@nestjs/common";
import { ApiBody, ApiExcludeController, ApiOperation, ApiProperty, ApiResponse, ApiTags } from "@nestjs/swagger";
import { IsInt, IsOptional, IsString, Matches, Min } from "class-validator";
import type { Request } from "express";
import { CryptoGatewayService } from "./crypto-gateway.service";

class CreateCryptoPaymentDto {
  @ApiProperty({ minimum: 1, example: 7900, description: "USD cents, surcharge included." })
  @IsInt() @Min(1) amount_cents!: number;

  @ApiProperty({ example: "usdttrc20", description: "Ticker from GET /payments/crypto/config." })
  @IsString() @Matches(/^[a-z0-9]{2,20}$/i) pay_currency!: string;

  @ApiProperty({ required: false }) @IsOptional() @IsString() description?: string;
  @ApiProperty({ required: false }) @IsOptional() @IsString() context?: string;
  @ApiProperty({ required: false }) @IsOptional() @IsString() service_name?: string;
  @ApiProperty({ required: false }) @IsOptional() @IsString() client_name?: string;
  @ApiProperty({ required: false }) @IsOptional() @IsString() client_email?: string;
  @ApiProperty({ required: false }) @IsOptional() @IsString() client_phone?: string;
  @ApiProperty({ required: false }) @IsOptional() @IsString() plan_name?: string;
  @ApiProperty({ required: false }) @IsOptional() @IsString() duration?: string;
  @ApiProperty({ required: false }) @IsOptional() @IsString() booking_id?: string;
  @ApiProperty({ required: false }) @IsOptional() @IsString() admin_url?: string;
  @ApiProperty({ required: false }) @IsOptional() @IsString() selected_date_time?: string;
  // Checkouts spread the same meta into every rail; the global pipe is
  // forbidNonWhitelisted, so accept what the Bitcoin DTO accepts.
  @ApiProperty({ required: false }) @IsOptional() @IsString() package_id?: string;
  @ApiProperty({ required: false }) @IsOptional() @IsInt() @Min(1) billing_period_months?: number;
}

class CryptoStatusDto {
  @ApiProperty({ example: "5077125051" })
  @IsString() payment_id!: string;
}

/** What the browser is allowed to see of a gateway payment. */
function publicView(p: Awaited<ReturnType<CryptoGatewayService["verify"]>> | Awaited<ReturnType<CryptoGatewayService["createPayment"]>>) {
  return {
    payment_id: p.paymentId,
    state: p.state,
    paid: "paid" in p ? p.paid : false,
    pay_address: p.payAddress,
    pay_extra_id: p.payExtraId,
    pay_amount: p.payAmount,
    pay_currency: p.payCurrency,
    expires_at: p.expiresAt,
  };
}

@ApiTags("Payments")
@Controller("payments/crypto")
export class CryptoPaymentsController {
  constructor(private readonly crypto: CryptoGatewayService) {}

  @ApiOperation({ summary: "Is the crypto gateway on, and which coins does it take" })
  @Get("config")
  async config() {
    if (!this.crypto.enabled) return { enabled: false, provider: null, currencies: [] };
    return { enabled: true, provider: this.crypto.providerKey, currencies: await this.crypto.currencies() };
  }

  @ApiOperation({ summary: "Create a crypto payment (address + exact amount in the chosen coin)" })
  @ApiBody({ type: CreateCryptoPaymentDto })
  @ApiResponse({ status: 201, description: "Payment created." })
  @ApiResponse({ status: 400, description: "Coin refused it (usually: below that coin's minimum)." })
  @ApiResponse({ status: 503, description: "Gateway not configured or failing." })
  @Post("payment")
  async create(@Body() body: CreateCryptoPaymentDto) {
    const { amount_cents, pay_currency, ...meta } = body;
    const payment = await this.crypto.createPayment({ amountCents: amount_cents, payCurrency: pay_currency, meta });
    return publicView(payment);
  }

  @ApiOperation({ summary: "Poll a crypto payment; settles the order server-side when paid" })
  @ApiBody({ type: CryptoStatusDto })
  @Post("status")
  async status(@Body() body: CryptoStatusDto) {
    const result = await this.crypto.verify(body.payment_id);
    // Settle here too, not only in the webhook: the browser often knows first,
    // and settle() is idempotent with the webhook and the cron.
    if (result.paid) await this.crypto.settle(body.payment_id, "viaPoll");
    return publicView(result);
  }
}

/**
 * Gateway callbacks. Same discipline as the Blink webhook: the body is a hint
 * about WHICH payment moved; whether it is paid is asked of the gateway itself.
 * An unsigned or unreadable body degrades to "re-check what we are waiting
 * on", which is harmless if someone POSTs noise at the URL.
 */
@ApiExcludeController()
@Controller("webhooks/crypto")
export class CryptoWebhookController {
  private readonly logger = new Logger("CryptoWebhook");

  constructor(private readonly crypto: CryptoGatewayService) {}

  @Post(":gateway")
  @HttpCode(200)
  async handle(@Param("gateway") gateway: string, @Body() body: Record<string, unknown>, @Req() req: Request) {
    if (!this.crypto.enabled) return { ok: true, action: "disabled" };
    const { trusted, paymentId } = this.crypto.verifyCallback(gateway, body ?? {}, req.headers);
    this.logger.log(`callback gateway=${gateway} trusted=${trusted} payment=${paymentId ?? "-"}`);

    try {
      if (trusted && paymentId) {
        const result = await this.crypto.verify(paymentId);
        if (result.paid) {
          const settled = await this.crypto.settle(paymentId, "viaWebhook");
          return { ok: true, action: settled ? "confirmed" : "already_settled" };
        }
        return { ok: true, action: "not_paid", state: result.state };
      }
      const swept = await this.crypto.sweepPending();
      return { ok: true, action: swept ? "confirmed_by_sweep" : "nothing_to_do", confirmed: swept };
    } catch (e) {
      // Never 5xx a gateway: it retries, and a retry storm helps nobody. The
      // cron reconcile is the backstop.
      this.logger.warn(`callback handling failed: ${(e as Error).message}`);
      return { ok: true, action: "error" };
    }
  }
}
