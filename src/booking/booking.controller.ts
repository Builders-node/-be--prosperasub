import { BadRequestException, Body, Controller, Get, Param, Post, Query, Req, UseGuards } from "@nestjs/common";
import { ApiOperation, ApiTags } from "@nestjs/swagger";
import { IsOptional, IsString } from "class-validator";
import { AccountAuthGuard, type AccountRequest } from "../account/account-auth.guard";
import { BookingService } from "./booking.service";

class HoldDto {
  @IsString() resource_id!: string;
  @IsString() date!: string; // YYYY-MM-DD
  @IsString() from!: string; // HH:MM
  @IsOptional() @IsString() label?: string;
  @IsOptional() @IsString() notes?: string;
}
class WaitlistDto extends HoldDto {}
class ConfirmDto {
  @IsOptional() @IsString() order_ref?: string;
}

/**
 * Booking domain surface. Availability is public; mutations require an account
 * token (the subject is taken from the auth guard, never trusted from the body).
 */
@ApiTags("Booking")
@Controller("booking")
export class BookingController {
  constructor(private readonly booking: BookingService) {}

  @ApiOperation({ summary: "Generated availability slots for a resource on a date" })
  @Get("availability")
  availability(@Query("resourceId") resourceId?: string, @Query("date") date?: string) {
    if (!resourceId || !date) throw new BadRequestException("resourceId and date (YYYY-MM-DD) are required");
    return this.booking.getAvailability(resourceId, date);
  }

  @ApiOperation({ summary: "Active bookings for a resource on a date" })
  @Get("bookings")
  listBookings(@Query("resourceId") resourceId?: string, @Query("date") date?: string) {
    if (!resourceId || !date) throw new BadRequestException("resourceId and date (YYYY-MM-DD) are required");
    return this.booking.listBookings(resourceId, date);
  }

  @ApiOperation({ summary: "Hold a slot (TTL) for the authenticated subject" })
  @UseGuards(AccountAuthGuard)
  @Post("hold")
  hold(@Req() req: AccountRequest, @Body() body: HoldDto) {
    return this.booking.hold({
      resourceId: body.resource_id, date: body.date, from: body.from,
      subjectRef: `user:${req.authUser!.id}`,
      label: body.label ?? null, notes: body.notes ?? null,
    });
  }

  @ApiOperation({ summary: "Confirm a held slot" })
  @UseGuards(AccountAuthGuard)
  @Post("holds/:id/confirm")
  confirm(@Param("id") id: string, @Body() body: ConfirmDto) {
    return this.booking.confirm(id, body.order_ref);
  }

  @ApiOperation({ summary: "Cancel a booking" })
  @UseGuards(AccountAuthGuard)
  @Post("bookings/:id/cancel")
  cancel(@Param("id") id: string) {
    return this.booking.cancel(id);
  }

  @ApiOperation({ summary: "Join the waitlist for a slot" })
  @UseGuards(AccountAuthGuard)
  @Post("waitlist")
  waitlist(@Req() req: AccountRequest, @Body() body: WaitlistDto) {
    return this.booking.joinWaitlist({ resourceId: body.resource_id, date: body.date, from: body.from, subjectRef: `user:${req.authUser!.id}` });
  }
}
