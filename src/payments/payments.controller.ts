import { BadRequestException, Body, Controller, Post } from "@nestjs/common";
import { ApiBody, ApiOperation, ApiProperty, ApiResponse, ApiTags } from "@nestjs/swagger";
import { IsInt, IsOptional, IsString, Min } from "class-validator";
import { CatalogService, type CleaningPackageDto } from "../catalog/catalog.service";
import { resolveMonthlyPriceCents } from "../catalog/cleaning-plan-pricing";
import { NotificationsService } from "../notifications/notifications.service";
import { BlinkService } from "./blink.service";

class CreateLightningInvoiceDto {
  @ApiProperty({ required: false, minimum: 1, example: 100, description: "USD cents. Required by the current Blink USD invoice implementation." })
  @IsOptional()
  @IsInt()
  @Min(1)
  amount_cents?: number;

  @ApiProperty({ required: false, minimum: 1, example: 1000, description: "Accepted by validation but not used by the current USD invoice implementation." })
  @IsOptional()
  @IsInt()
  @Min(1)
  amount_sats?: number;

  @ApiProperty({ example: "Admin test invoice" })
  @IsString()
  description!: string;

  @ApiProperty({ required: false, example: "admin-test-1", description: "Sanitized before it is sent to Blink." })
  @IsOptional()
  @IsString()
  external_id?: string;

  @ApiProperty({ required: false, example: "cleaning_subscription", description: "Optional payment context for server-side amount validation." })
  @IsOptional()
  @IsString()
  context?: string;

  @ApiProperty({ required: false, example: "cleaning-1-bedroom-studio" })
  @IsOptional()
  @IsString()
  package_id?: string;

  @ApiProperty({ required: false, minimum: 1, maximum: 3, example: 3 })
  @IsOptional()
  @IsInt()
  @Min(1)
  billing_period_months?: number;

  @ApiProperty({ required: false, example: "Cleaning subscription" })
  @IsOptional()
  @IsString()
  service_name?: string;

  @ApiProperty({ required: false, example: "Frorex Studio" })
  @IsOptional()
  @IsString()
  client_name?: string;

  @ApiProperty({ required: false, example: "customer@example.com" })
  @IsOptional()
  @IsString()
  client_email?: string;

  @ApiProperty({ required: false, example: "+1 555 0100" })
  @IsOptional()
  @IsString()
  client_phone?: string;

  @ApiProperty({ required: false, example: "1 Bedroom & Studio" })
  @IsOptional()
  @IsString()
  plan_name?: string;

  @ApiProperty({ required: false, example: "3 months" })
  @IsOptional()
  @IsString()
  duration?: string;

  @ApiProperty({ required: false, example: "booking_123" })
  @IsOptional()
  @IsString()
  booking_id?: string;

  @ApiProperty({ required: false, example: "https://prosperasub.com/admin/subscriptions" })
  @IsOptional()
  @IsString()
  admin_url?: string;

  @ApiProperty({ required: false, example: "Pending schedule" })
  @IsOptional()
  @IsString()
  selected_date_time?: string;
}

class LightningStatusDto {
  @ApiProperty({ example: "blink-payment-hash" })
  @IsString()
  payment_hash!: string;

  @ApiProperty({ required: false, example: "Cleaning subscription" })
  @IsOptional()
  @IsString()
  service_name?: string;

  @ApiProperty({ required: false, example: "Frorex Studio" })
  @IsOptional()
  @IsString()
  client_name?: string;

  @ApiProperty({ required: false, example: "customer@example.com" })
  @IsOptional()
  @IsString()
  client_email?: string;

  @ApiProperty({ required: false, example: "+1 555 0100" })
  @IsOptional()
  @IsString()
  client_phone?: string;

  @ApiProperty({ required: false, example: "1 Bedroom & Studio" })
  @IsOptional()
  @IsString()
  plan_name?: string;

  @ApiProperty({ required: false, example: "3 months" })
  @IsOptional()
  @IsString()
  duration?: string;

  @ApiProperty({ required: false, example: "booking_123" })
  @IsOptional()
  @IsString()
  booking_id?: string;

  @ApiProperty({ required: false, example: "https://prosperasub.com/admin/subscriptions" })
  @IsOptional()
  @IsString()
  admin_url?: string;

  @ApiProperty({ required: false, example: "Tuesday 10:00 - 12:00" })
  @IsOptional()
  @IsString()
  selected_date_time?: string;
}

@ApiTags("Payments")
@Controller("payments/lightning")
export class PaymentsController {
  constructor(
    private readonly blink: BlinkService,
    private readonly catalog: CatalogService,
    private readonly notifications: NotificationsService
  ) {}

  @ApiOperation({ summary: "Create a Blink USD Lightning invoice" })
  @ApiBody({ type: CreateLightningInvoiceDto })
  @ApiResponse({ status: 201, description: "Lightning invoice created." })
  @ApiResponse({ status: 400, description: "amount_cents is missing or invalid." })
  @ApiResponse({ status: 503, description: "Blink is not configured or returned an error." })
  @Post("invoice")
  async createInvoice(@Body() body: CreateLightningInvoiceDto) {
    if (!body.amount_cents) {
      throw new BadRequestException("amount_cents is required for Blink USD Lightning invoices.");
    }

    let cleaningPackage: CleaningPackageDto | undefined;
    if (body.context === "cleaning_subscription") {
      cleaningPackage = await this.validateCleaningInvoiceAmount(body);
    }

    const invoice = await this.blink.createUsdInvoice({
      amountCents: body.amount_cents,
      memo: body.description,
      externalId: body.external_id
    });

    await this.notifications.recordCheckoutSession({
      provider: "blink",
      providerPaymentId: invoice.payment_hash,
      context: body.context,
      serviceName: this.resolveServiceName(body),
      clientName: body.client_name ?? null,
      clientEmail: body.client_email ?? null,
      clientPhone: body.client_phone ?? null,
      amountCents: body.amount_cents,
      amountSats: invoice.amount_sats ?? body.amount_sats ?? null,
      currency: "USD",
      planName: this.resolvePlanName(body, cleaningPackage),
      duration: this.resolveDuration(body),
      bookingId: body.booking_id ?? null,
      adminUrl: body.admin_url ?? null,
      selectedDateTime: body.selected_date_time ?? null,
      description: body.description,
      externalId: body.external_id ?? null
    });

    return invoice;
  }

  private async validateCleaningInvoiceAmount(body: CreateLightningInvoiceDto) {
    const validMonths = [1, 2, 3];
    if (!body.package_id || !body.billing_period_months || !validMonths.includes(body.billing_period_months)) {
      throw new BadRequestException("Cleaning invoice requires package_id and billing_period_months of 1, 2, or 3.");
    }

    const cleaningPackage = await this.catalog.getCleaningPackage(body.package_id);
    if (!cleaningPackage) {
      throw new BadRequestException("Cleaning package was not found.");
    }

    const monthlyPriceCents = resolveMonthlyPriceCents(cleaningPackage);
    const expectedTotalCents = monthlyPriceCents * body.billing_period_months;
    if (body.amount_cents !== expectedTotalCents) {
      throw new BadRequestException("Cleaning invoice amount does not match the selected package and duration.");
    }

    return cleaningPackage;
  }

  @ApiOperation({ summary: "Check Blink Lightning invoice status" })
  @ApiBody({ type: LightningStatusDto })
  @ApiResponse({ status: 201, description: "Payment status returned." })
  @ApiResponse({ status: 503, description: "Blink is not configured or returned an error." })
  @Post("status")
  async paymentStatus(@Body() body: LightningStatusDto) {
    const status = await this.blink.getPaymentStatus(body.payment_hash);

    if (status.paid) {
      await this.notifications.notifyPaymentSucceededForProviderRef("blink", body.payment_hash, {
        serviceName: body.service_name,
        clientName: body.client_name,
        clientEmail: body.client_email,
        clientPhone: body.client_phone,
        planName: body.plan_name,
        duration: body.duration,
        bookingId: body.booking_id,
        adminUrl: body.admin_url,
        selectedDateTime: body.selected_date_time,
        paymentStatus: "paid",
        paidAt: new Date()
      });
    }

    return status;
  }

  private resolveServiceName(body: CreateLightningInvoiceDto) {
    if (body.service_name) return body.service_name;
    if (body.context === "cleaning_subscription") return "Cleaning subscription";
    if (body.context === "admin_test_payment") return "Admin test payment";
    return "ProsperaSub payment";
  }

  private resolvePlanName(body: CreateLightningInvoiceDto, cleaningPackage?: CleaningPackageDto) {
    if (body.plan_name) return body.plan_name;
    if (body.context === "cleaning_subscription" && body.package_id) {
      return cleaningPackage?.name ?? body.package_id;
    }
    return null;
  }

  private resolveDuration(body: CreateLightningInvoiceDto) {
    if (body.duration) return body.duration;
    if (body.context === "cleaning_subscription" && body.billing_period_months) {
      return `${body.billing_period_months} month${body.billing_period_months === 1 ? "" : "s"}`;
    }
    return null;
  }
}
