import { Body, Controller, Get, Param, Post, UseGuards } from "@nestjs/common";
import { ApiHeader, ApiOperation, ApiProperty, ApiResponse, ApiTags } from "@nestjs/swagger";
import { IsArray, IsBoolean, IsInt, IsNumber, IsObject, IsOptional, IsString, Min } from "class-validator";
import { SimpleFiService } from "./simplefi.service";
import { PublicApiKeyGuard } from "./public-api-key.guard";

class PublicCoinDto {
  @ApiProperty({ example: 900 })
  @IsInt()
  chain_id!: number;

  @ApiProperty({ example: "LIVES" })
  @IsString()
  ticker!: string;
}

class CreatePublicPaymentDto {
  @ApiProperty({ required: false, example: 0.1, description: "Amount in currency units (use this OR amount_cents)" })
  @IsOptional()
  @IsNumber()
  amount?: number;

  @ApiProperty({ required: false, example: 1000, description: "Amount in cents (use this OR amount)" })
  @IsOptional()
  @IsInt()
  @Min(1)
  amount_cents?: number;

  @ApiProperty({ required: false, example: "USD" })
  @IsOptional()
  @IsString()
  currency?: string;

  @ApiProperty({ required: false, example: "Order #123" })
  @IsOptional()
  @IsString()
  description?: string;

  @ApiProperty({ required: false, description: "Arbitrary metadata returned back in webhooks/status (e.g. { orderId })" })
  @IsOptional()
  @IsObject()
  reference?: Record<string, unknown>;

  @ApiProperty({ required: false, type: [PublicCoinDto], description: "Restrict to specific coins/networks" })
  @IsOptional()
  @IsArray()
  coins?: PublicCoinDto[];

  @ApiProperty({ required: false, default: false })
  @IsOptional()
  @IsBoolean()
  card_payment?: boolean;

  @ApiProperty({ required: false, description: "Your own webhook URL for SimpleFi notifications" })
  @IsOptional()
  @IsString()
  notification_url?: string;
}

@ApiTags("Public Payments API")
@ApiHeader({ name: "x-api-key", description: "Your ProsperaSub public API key", required: true })
@UseGuards(PublicApiKeyGuard)
@Controller("v1/payments")
export class PublicPaymentsController {
  constructor(private readonly simplefi: SimpleFiService) {}

  @ApiOperation({ summary: "Create a crypto (LIVES/Infinita via SimpleFi) payment. Redirect the buyer to checkout_url." })
  @ApiResponse({ status: 201, description: "Returns payment_id, checkout_url and status." })
  @Post()
  async create(@Body() body: CreatePublicPaymentDto) {
    const amount = body.amount != null ? body.amount : (body.amount_cents != null ? body.amount_cents / 100 : 0);
    return this.simplefi.createPayment({
      amount,
      currency: body.currency,
      description: body.description,
      reference: body.reference,
      coins: body.coins,
      cardPayment: body.card_payment,
      notificationUrl: body.notification_url,
    });
  }

  @ApiOperation({ summary: "Check a payment status. `paid` is true once settled (approved/paid/confirmed/completed)." })
  @ApiResponse({ status: 200, description: "Returns { paid, status, payment_id }." })
  @Get(":id")
  async status(@Param("id") id: string) {
    return this.simplefi.getPaymentStatus(id);
  }
}
