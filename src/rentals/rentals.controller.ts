import { Body, Controller, Param, Post, Req, UseGuards } from "@nestjs/common";
import { ApiOperation, ApiTags } from "@nestjs/swagger";
import { IsArray, IsOptional, IsString } from "class-validator";
import { AccountAuthGuard, type AccountRequest } from "../account/account-auth.guard";
import { RentalsService } from "./rentals.service";

class CreateRentalDto {
  @IsString() vehicle_id!: string;
  @IsString() start_date!: string;
  @IsString() end_date!: string;
  @IsOptional() @IsString() insurance_tier_id?: string;
  @IsOptional() @IsArray() extra_ids?: string[];
  @IsOptional() @IsString() delivery_zone_id?: string;
  @IsString() payment_method!: string;
  @IsOptional() @IsString() customer_name?: string;
  @IsOptional() @IsString() customer_whatsapp?: string;
  @IsOptional() @IsString() delivery_address?: string;
  @IsOptional() @IsString() delivery_notes?: string;
}

class ConfirmRentalDto {
  @IsString() payment_reference!: string;
  @IsString() payment_method!: string;
}

/**
 * Car-rental booking surface. The caller names what they want; the server
 * prices it, reserves it, and — once the payment provider itself says paid —
 * confirms it. See RentalsService for why the browser no longer writes the row.
 */
@ApiTags("Rentals")
@UseGuards(AccountAuthGuard)
@Controller("rentals")
export class RentalsController {
  constructor(private readonly rentals: RentalsService) {}

  @ApiOperation({ summary: "Reserve a car for a date range (pending payment)" })
  @Post("bookings")
  create(@Req() req: AccountRequest, @Body() body: CreateRentalDto) {
    return this.rentals.create({
      vehicleId: body.vehicle_id,
      startDate: body.start_date,
      endDate: body.end_date,
      insuranceTierId: body.insurance_tier_id ?? null,
      extraIds: (body.extra_ids ?? []).map(String),
      deliveryZoneId: body.delivery_zone_id ?? null,
      paymentMethod: body.payment_method,
      customerName: body.customer_name ?? null,
      customerWhatsapp: body.customer_whatsapp ?? null,
      deliveryAddress: body.delivery_address ?? null,
      deliveryNotes: body.delivery_notes ?? null,
    }, req.authUser!.id);
  }

  @ApiOperation({ summary: "Confirm a rental against a verified payment" })
  @Post("bookings/:id/confirm")
  confirm(@Req() req: AccountRequest, @Param("id") id: string, @Body() body: ConfirmRentalDto) {
    return this.rentals.confirm(id, {
      paymentReference: body.payment_reference,
      paymentMethod: body.payment_method,
    }, req.authUser!.id);
  }
}
