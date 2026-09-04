import { Body, Controller, ForbiddenException, Headers, Post, UnauthorizedException } from "@nestjs/common";
import { ApiBearerAuth, ApiBody, ApiOperation, ApiProperty, ApiResponse, ApiTags } from "@nestjs/swagger";
import { IsEmail, IsIn, IsInt, IsOptional, IsString, Min } from "class-validator";
import { SessionService } from "../auth/session.service";
import { MailService } from "./mail.service";
import { ProviderOrderMailService } from "./provider-order-mail.service";

class PaymentConfirmationEmailDto {
  @ApiProperty({ required: false, example: "user@example.com" })
  @IsOptional()
  @IsEmail()
  email?: string;

  @ApiProperty({ required: false, example: "User Name" })
  @IsOptional()
  @IsString()
  customerName?: string;

  @ApiProperty({ example: "1 Bedroom & Studio" })
  @IsString()
  planName!: string;

  @ApiProperty({ minimum: 1, example: 7900 })
  @IsInt()
  @Min(1)
  monthlyPriceCents!: number;

  @ApiProperty({ minimum: 1, example: 23700 })
  @IsInt()
  @Min(1)
  totalCents!: number;

  @ApiProperty({ enum: [1, 2, 3], example: 3 })
  @IsInt()
  @IsIn([1, 2, 3])
  billingPeriodMonths!: number;

  @ApiProperty({ example: "2026-06-01" })
  @IsString()
  serviceStartDate!: string;

  @ApiProperty({ example: "2026-09-01" })
  @IsString()
  serviceEndDate!: string;

  @ApiProperty({ example: "2026-09-01" })
  @IsString()
  paidUntil!: string;

  @ApiProperty({ required: false, example: "blink-payment-hash" })
  @IsOptional()
  @IsString()
  paymentReference?: string;

  @ApiProperty({ required: false, example: "Duna Tower, Apt 1204" })
  @IsOptional()
  @IsString()
  apartmentNote?: string;
}

class NewOrderEmailDto {
  @ApiProperty({ example: "provider_subscriptions" })
  @IsString()
  table!: string;

  @ApiProperty({ example: "7c1a…" })
  @IsString()
  orderId!: string;
}

@ApiTags("Mail")
@Controller("mail")
export class MailController {
  constructor(
    private readonly mail: MailService,
    private readonly providerOrderMail: ProviderOrderMailService,
    private readonly sessions: SessionService
  ) {}

  /**
   * Tell the business that sold it. Called by a checkout the moment the order
   * row exists; the reconcile cron calls the same service when a payment
   * lands, and the ledger makes the second call a no-op.
   *
   * The body names an order, nothing more: the amounts, the dates and the
   * recipients are read server-side, so a caller cannot dictate what the
   * email says or who receives it. Auth is any signed-in account — the person
   * who just bought — and an unknown id is simply not notified.
   */
  @ApiBearerAuth()
  @ApiOperation({ summary: "Email a provider's owner and team that they have a new order" })
  @ApiBody({ type: NewOrderEmailDto })
  @ApiResponse({ status: 201, description: "Notification attempted; body says whether it was sent." })
  @Post("new-order")
  async sendNewOrder(
    @Headers("authorization") authorization: string | undefined,
    @Body() body: NewOrderEmailDto
  ) {
    this.verifyBearer(authorization);
    return this.providerOrderMail.notifyNewOrder(body.table, body.orderId);
  }

  @ApiBearerAuth()
  @ApiOperation({ summary: "Send a cleaning payment confirmation email to the authenticated user" })
  @ApiBody({ type: PaymentConfirmationEmailDto })
  @ApiResponse({ status: 201, description: "Email send attempted." })
  @ApiResponse({ status: 401, description: "Missing or invalid access token." })
  @ApiResponse({ status: 403, description: "Only super admins can send to another email address." })
  @Post("payment-confirmation")
  async sendPaymentConfirmation(
    @Headers("authorization") authorization: string | undefined,
    @Body() body: PaymentConfirmationEmailDto
  ) {
    const payload = this.verifyBearer(authorization);
    const roles = payload.roles ?? [];
    const tokenEmail = payload.email?.trim().toLowerCase();
    const requestedEmail = body.email?.trim().toLowerCase();
    const to = requestedEmail || tokenEmail;

    if (!to) {
      throw new UnauthorizedException("Authenticated email is required.");
    }

    if (requestedEmail && requestedEmail !== tokenEmail && !roles.includes("SUPER_ADMIN")) {
      throw new ForbiddenException("Only super admins can send payment emails to another user.");
    }

    return this.mail.sendPaymentConfirmationEmail({
      to,
      customerName: body.customerName || payload.name,
      planName: body.planName,
      monthlyPriceCents: body.monthlyPriceCents,
      totalCents: body.totalCents,
      billingPeriodMonths: body.billingPeriodMonths,
      serviceStartDate: body.serviceStartDate,
      serviceEndDate: body.serviceEndDate,
      paidUntil: body.paidUntil,
      paymentReference: body.paymentReference,
      apartmentNote: body.apartmentNote
    });
  }

  private verifyBearer(authorization?: string) {
    const [scheme, token] = authorization?.split(" ") ?? [];
    if (scheme?.toLowerCase() !== "bearer" || !token) {
      throw new UnauthorizedException("Access token is required.");
    }

    return this.sessions.verifyAccessToken(token);
  }
}
