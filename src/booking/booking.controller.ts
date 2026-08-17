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

  @ApiOperation({ summary: "Every booking the authenticated subject holds" })
  @UseGuards(AccountAuthGuard)
  @Get("mine")
  mine(@Req() req: AccountRequest, @Query("from") from?: string, @Query("to") to?: string) {
    return this.booking.listForSubject(`user:${req.authUser!.id}`, { from, to });
  }

  /**
   * What the caller's plans open here.
   *
   * The booking screen asks this so a calendar a plan does not include is
   * shown as not included, rather than refusing the tap with
   * `resource_not_in_plan` after the customer has chosen a time.
   */
  @ApiOperation({ summary: "Which of a provider's calendars your plans include" })
  @UseGuards(AccountAuthGuard)
  @Get("coverage")
  coverage(
    @Req() req: AccountRequest,
    @Query("providerId") providerId?: string,
    @Query("resourceId") resourceId?: string,
  ) {
    if (!providerId) throw new BadRequestException("providerId is required");
    // The allowance is per calendar — a plan can cap one court and not another
    // — so the screen names the one it is showing.
    return this.booking.coverageFor(`user:${req.authUser!.id}`, providerId, resourceId);
  }

  @ApiOperation({ summary: "Every booking on a provider's calendars in a window" })
  @UseGuards(AccountAuthGuard)
  @Get("by-provider")
  byProvider(
    @Query("providerId") providerId?: string,
    @Query("from") from?: string,
    @Query("to") to?: string,
  ) {
    if (!providerId) throw new BadRequestException("providerId is required");
    return this.booking.listForProvider(providerId, { from, to });
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

  @ApiOperation({ summary: "Cancel a booking — your own, or anyone's if you are staff" })
  @UseGuards(AccountAuthGuard)
  @Post("bookings/:id/cancel")
  cancel(@Param("id") id: string, @Req() req: AccountRequest) {
    // Roles ride on the access token, so the provider's own desk can cancel on
    // a customer's behalf — a court freed by a phone call is still freed —
    // while a customer may only cancel what is theirs.
    const roles = req.authUser?.roles ?? [];
    const isStaff = roles.some((r) => ["admin", "super_admin", "manager"].includes(String(r)));
    return this.booking.cancel(id, { subjectRef: `user:${req.authUser!.id}`, isStaff });
  }

  @ApiOperation({ summary: "Join the waitlist for a slot" })
  @UseGuards(AccountAuthGuard)
  @Post("waitlist")
  waitlist(@Req() req: AccountRequest, @Body() body: WaitlistDto) {
    return this.booking.joinWaitlist({ resourceId: body.resource_id, date: body.date, from: body.from, subjectRef: `user:${req.authUser!.id}` });
  }
}
