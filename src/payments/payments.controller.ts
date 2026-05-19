import { BadRequestException, Body, Controller, Post } from "@nestjs/common";
import { ApiBody, ApiOperation, ApiProperty, ApiResponse, ApiTags } from "@nestjs/swagger";
import { IsInt, IsOptional, IsString, Min } from "class-validator";
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
}

class LightningStatusDto {
  @ApiProperty({ example: "blink-payment-hash" })
  @IsString()
  payment_hash!: string;
}

@ApiTags("Payments")
@Controller("payments/lightning")
export class PaymentsController {
  constructor(private readonly blink: BlinkService) {}

  @ApiOperation({ summary: "Create a Blink USD Lightning invoice" })
  @ApiBody({ type: CreateLightningInvoiceDto })
  @ApiResponse({ status: 201, description: "Lightning invoice created." })
  @ApiResponse({ status: 400, description: "amount_cents is missing or invalid." })
  @ApiResponse({ status: 503, description: "Blink is not configured or returned an error." })
  @Post("invoice")
  createInvoice(@Body() body: CreateLightningInvoiceDto) {
    if (!body.amount_cents) {
      throw new BadRequestException("amount_cents is required for Blink USD Lightning invoices.");
    }

    return this.blink.createUsdInvoice({
      amountCents: body.amount_cents,
      memo: body.description,
      externalId: body.external_id
    });
  }

  @ApiOperation({ summary: "Check Blink Lightning invoice status" })
  @ApiBody({ type: LightningStatusDto })
  @ApiResponse({ status: 201, description: "Payment status returned." })
  @ApiResponse({ status: 503, description: "Blink is not configured or returned an error." })
  @Post("status")
  paymentStatus(@Body() body: LightningStatusDto) {
    return this.blink.getPaymentStatus(body.payment_hash);
  }
}
