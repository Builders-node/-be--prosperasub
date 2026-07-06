import { BadRequestException, Body, Controller, Post } from "@nestjs/common";
import { ApiBody, ApiOperation, ApiProperty, ApiResponse, ApiTags } from "@nestjs/swagger";
import { IsInt, IsOptional, IsString, Min } from "class-validator";
import { NotificationsService } from "../notifications/notifications.service";
import { BillingService } from "../billing/billing.service";
import { SimpleFiService } from "./simplefi.service";

class CreateSimpleFiInvoiceDto {
  @ApiProperty({ minimum: 1, example: 10000, description: "Amount in USD cents" })
  @IsInt()
  @Min(1)
  amount_cents!: number;

  @ApiProperty({ example: "Car rental: Tesla Model 3" })
  @IsString()
  description!: string;

  @ApiProperty({ required: false, example: "car_rental" })
  @IsOptional()
  @IsString()
  context?: string;

  @ApiProperty({ required: false })
  @IsOptional()
  @IsString()
  service_name?: string;

  @ApiProperty({ required: false })
  @IsOptional()
  @IsString()
  client_name?: string;

  @ApiProperty({ required: false })
  @IsOptional()
  @IsString()
  client_email?: string;

  @ApiProperty({ required: false })
  @IsOptional()
  @IsString()
  client_phone?: string;

  @ApiProperty({ required: false })
  @IsOptional()
  @IsString()
  plan_name?: string;

  @ApiProperty({ required: false })
  @IsOptional()
  @IsString()
  duration?: string;

  @ApiProperty({ required: false })
  @IsOptional()
  @IsString()
  booking_id?: string;

  @ApiProperty({ required: false })
  @IsOptional()
  @IsString()
  admin_url?: string;

  @ApiProperty({ required: false })
  @IsOptional()
  @IsString()
  selected_date_time?: string;
}

class SimpleFiStatusDto {
  @ApiProperty({ example: "6a2b..." })
  @IsString()
  payment_id!: string;

  @ApiProperty({ required: false })
  @IsOptional()
  @IsString()
  service_name?: string;

  @ApiProperty({ required: false })
  @IsOptional()
  @IsString()
  client_name?: string;

  @ApiProperty({ required: false })
  @IsOptional()
  @IsString()
  client_email?: string;

  @ApiProperty({ required: false })
  @IsOptional()
  @IsString()
  plan_name?: string;

  @ApiProperty({ required: false })
  @IsOptional()
  @IsString()
  duration?: string;

  @ApiProperty({ required: false })
  @IsOptional()
  @IsString()
  booking_id?: string;

  @ApiProperty({ required: false })
  @IsOptional()
  @IsString()
  admin_url?: string;

  @ApiProperty({ required: false })
  @IsOptional()
  @IsString()
  selected_date_time?: string;
}

@ApiTags("Payments")
@Controller("payments/simplefi")
export class SimpleFiPaymentsController {
  constructor(
    private readonly simplefi: SimpleFiService,
    private readonly notifications: NotificationsService,
    private readonly billing: BillingService
  ) {}

  @ApiOperation({ summary: "Create a SimpleFi / Infinita payment request" })
  @ApiBody({ type: CreateSimpleFiInvoiceDto })
  @ApiResponse({ status: 201, description: "Payment request created." })
  @Post("invoice")
  async createInvoice(@Body() body: CreateSimpleFiInvoiceDto) {
    if (!body.amount_cents) {
      throw new BadRequestException("amount_cents is required.");
    }

    const result = await this.simplefi.createInvoice({
      amountCents: body.amount_cents,
      description: body.description,
      reference: {
        context: body.context,
        service_name: body.service_name,
        client_name: body.client_name,
        client_email: body.client_email,
        plan_name: body.plan_name,
        duration: body.duration,
        booking_id: body.booking_id,
      },
    });

    await this.notifications.recordCheckoutSession({
      provider: "simplefi",
      providerPaymentId: result.payment_id,
      context: body.context,
      serviceName: body.service_name || "ProsperaSub payment",
      clientName: body.client_name ?? null,
      clientEmail: body.client_email ?? null,
      clientPhone: body.client_phone ?? null,
      amountCents: body.amount_cents,
      amountSats: null,
      currency: "USD",
      planName: body.plan_name ?? null,
      duration: body.duration ?? null,
      bookingId: body.booking_id ?? null,
      adminUrl: body.admin_url ?? null,
      selectedDateTime: body.selected_date_time ?? null,
      description: body.description,
      externalId: null,
    });

    return result;
  }

  @ApiOperation({ summary: "Check SimpleFi / Infinita payment status" })
  @ApiBody({ type: SimpleFiStatusDto })
  @ApiResponse({ status: 201, description: "Payment status returned." })
  @Post("status")
  async paymentStatus(@Body() body: SimpleFiStatusDto) {
    const status = await this.simplefi.getPaymentStatus(body.payment_id);

    if (status.paid) {
      await this.notifications.notifyPaymentSucceededForProviderRef("simplefi", body.payment_id, {
        serviceName: body.service_name,
        clientName: body.client_name,
        clientEmail: body.client_email,
        planName: body.plan_name,
        duration: body.duration,
        bookingId: body.booking_id,
        adminUrl: body.admin_url,
        selectedDateTime: body.selected_date_time,
        paymentStatus: "paid",
        paidAt: new Date(),
      });

      // Billing domain records the payment + emits billing.PaymentCaptured (idempotent).
      await this.billing.recordCaptured({
        method: "lives",
        provider: "simplefi",
        providerRef: body.payment_id,
        subjectRef: body.booking_id ? `booking:${body.booking_id}` : undefined,
        metadata: { serviceName: body.service_name ?? null, bookingId: body.booking_id ?? null }
      });
    }

    return status;
  }
}
