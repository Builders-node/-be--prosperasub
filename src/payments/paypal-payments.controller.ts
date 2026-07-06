import { Body, Controller, Get, Post } from "@nestjs/common";
import { ApiBody, ApiOperation, ApiProperty, ApiResponse, ApiTags } from "@nestjs/swagger";
import { IsInt, IsOptional, IsString, Min } from "class-validator";
import { PayPalService } from "./paypal.service";
import { NotificationsService } from "../notifications/notifications.service";
import { BillingService } from "../billing/billing.service";

class CreatePayPalOrderDto {
  @ApiProperty({ minimum: 1, example: 7900, description: "Amount in USD cents." })
  @IsInt()
  @Min(1)
  amount_cents!: number;

  @ApiProperty({ required: false, example: "Cleaning subscription" })
  @IsOptional() @IsString() description?: string;
  @ApiProperty({ required: false }) @IsOptional() @IsString() service_name?: string;
  @ApiProperty({ required: false }) @IsOptional() @IsString() client_name?: string;
  @ApiProperty({ required: false }) @IsOptional() @IsString() client_email?: string;
  @ApiProperty({ required: false }) @IsOptional() @IsString() client_phone?: string;
  @ApiProperty({ required: false }) @IsOptional() @IsString() plan_name?: string;
  @ApiProperty({ required: false }) @IsOptional() @IsString() duration?: string;
  @ApiProperty({ required: false }) @IsOptional() @IsString() booking_id?: string;
  @ApiProperty({ required: false }) @IsOptional() @IsString() admin_url?: string;
  @ApiProperty({ required: false }) @IsOptional() @IsString() selected_date_time?: string;
}

class CapturePayPalOrderDto {
  @ApiProperty({ example: "5O190127TN364715T" })
  @IsString()
  order_id!: string;
}

const PAYPAL_PROVIDER = "paypal";

@ApiTags("Payments")
@Controller("payments/paypal")
export class PayPalPaymentsController {
  constructor(
    private readonly paypal: PayPalService,
    private readonly notifications: NotificationsService,
    private readonly billing: BillingService
  ) {}

  @ApiOperation({ summary: "Public PayPal config for the checkout buttons" })
  @ApiResponse({ status: 200, description: "Client id, env and enabled flag." })
  @Get("config")
  getConfig() {
    return this.paypal.getPublicConfig();
  }

  @ApiOperation({ summary: "Create a PayPal order" })
  @ApiBody({ type: CreatePayPalOrderDto })
  @ApiResponse({ status: 201, description: "Order created." })
  @ApiResponse({ status: 503, description: "PayPal is not configured or returned an error." })
  @Post("order")
  async createOrder(@Body() body: CreatePayPalOrderDto) {
    const order = await this.paypal.createOrder({ amountCents: body.amount_cents, description: body.description });

    await this.notifications.recordCheckoutSession({
      provider: PAYPAL_PROVIDER,
      providerPaymentId: order.id,
      serviceName: body.service_name || body.description || "PayPal payment",
      clientName: body.client_name ?? null,
      clientEmail: body.client_email ?? null,
      clientPhone: body.client_phone ?? null,
      amountCents: body.amount_cents,
      currency: "USD",
      planName: body.plan_name ?? null,
      duration: body.duration ?? null,
      bookingId: body.booking_id ?? null,
      adminUrl: body.admin_url ?? null,
      selectedDateTime: body.selected_date_time ?? null,
      description: body.description ?? null
    });

    return order;
  }

  @ApiOperation({ summary: "Capture an approved PayPal order" })
  @ApiBody({ type: CapturePayPalOrderDto })
  @ApiResponse({ status: 201, description: "Capture result." })
  @ApiResponse({ status: 503, description: "PayPal is not configured or returned an error." })
  @Post("capture")
  async capture(@Body() body: CapturePayPalOrderDto) {
    const result = await this.paypal.captureOrder(body.order_id);
    if (result.paid) {
      await this.notifications.notifyPaymentSucceededForProviderRef(PAYPAL_PROVIDER, body.order_id, {
        paymentStatus: "paid",
        paidAt: new Date()
      });

      // Billing domain records the payment + emits billing.PaymentCaptured (idempotent).
      await this.billing.recordCaptured({
        method: "paypal",
        provider: "paypal",
        providerRef: result.capture_id ?? body.order_id,
        metadata: { orderId: body.order_id }
      });
    }
    return result;
  }
}
