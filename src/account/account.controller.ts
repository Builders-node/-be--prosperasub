import { Body, Controller, Get, Param, Patch, Post, Put, Query, Req, UseGuards } from "@nestjs/common";
import { ApiBearerAuth, ApiOperation, ApiProperty, ApiQuery, ApiTags } from "@nestjs/swagger";
import { IsBoolean, IsInt, IsOptional, IsString, Min, MinLength } from "class-validator";
import { AccountAuthGuard, type AccountRequest } from "./account-auth.guard";
import { AccountNotificationsService } from "./account-notifications.service";
import { AccountPasswordService } from "./account-password.service";
import { AccountPreferencesService } from "./account-preferences.service";
import { AccountPaymentService } from "./account-payment.service";
import { AccountCleaningService } from "./account-cleaning.service";
import { CleaningReminderService } from "./cleaning-reminder.service";

class ChangePasswordDto {
  @ApiProperty({ writeOnly: true })
  @IsString()
  current_password!: string;

  @ApiProperty({ writeOnly: true, minLength: 8 })
  @IsString()
  @MinLength(8)
  new_password!: string;
}

class RescheduleBookingDto {
  @ApiProperty()
  @IsString()
  slot_id!: string;
}

class UpdatePreferencesDto {
  @ApiProperty({ required: false })
  @IsOptional()
  @IsBoolean()
  reminder_enabled?: boolean;

  @ApiProperty({ required: false })
  @IsOptional()
  @IsString()
  reminder_method?: string;

  @ApiProperty({ required: false })
  @IsOptional()
  @IsInt()
  @Min(5)
  reminder_minutes_before?: number;

  @ApiProperty({ required: false, nullable: true })
  @IsOptional()
  @IsString()
  access_instructions?: string | null;
}

@ApiTags("Account")
@ApiBearerAuth()
@UseGuards(AccountAuthGuard)
@Controller("account")
export class AccountController {
  constructor(
    private readonly notifications: AccountNotificationsService,
    private readonly passwords: AccountPasswordService,
    private readonly preferences: AccountPreferencesService,
    private readonly reminders: CleaningReminderService,
    private readonly payment: AccountPaymentService,
    private readonly cleaning: AccountCleaningService,
  ) {}

  // ── Cleaning self-service ────────────────────────────────────────────────────

  @ApiOperation({ summary: "Reschedule one of the user's own cleaning bookings to another slot" })
  @Post("cleaning/bookings/:id/reschedule")
  rescheduleCleaningBooking(
    @Req() req: AccountRequest,
    @Param("id") id: string,
    @Body() body: RescheduleBookingDto,
  ) {
    return this.cleaning.rescheduleBooking(req.authUser!.id, id, body.slot_id);
  }

  @ApiOperation({ summary: "Sync one of the user's own cleaning bookings to Google Calendar" })
  @Post("cleaning/bookings/:id/sync")
  syncCleaningBooking(@Req() req: AccountRequest, @Param("id") id: string) {
    return this.cleaning.syncOwnBooking(req.authUser!.id, id);
  }

  @ApiOperation({
    summary: "Sync all of the user's own cleaning-subscription bookings to Google Calendar",
    description:
      "Called right after checkout so recurring bookings land on the shared admin calendar without waiting for the daily cron.",
  })
  @Post("cleaning/subscriptions/:id/sync-bookings")
  syncCleaningSubscriptionBookings(@Req() req: AccountRequest, @Param("id") id: string) {
    return this.cleaning.syncOwnSubscriptionBookings(req.authUser!.id, id);
  }

  // ── Notifications ──────────────────────────────────────────────────────────

  @ApiOperation({ summary: "Get user notifications" })
  @ApiQuery({ name: "category", required: false, description: "Filter by category: all | payment | subscription | booking | reminder | plan" })
  @ApiQuery({ name: "unread", required: false, type: Boolean })
  @Get("notifications")
  getNotifications(
    @Req() req: AccountRequest,
    @Query("category") category?: string,
    @Query("unread") unread?: string,
  ) {
    return this.notifications.getNotifications(req.authUser!.id, {
      category,
      unreadOnly: unread === "true",
    });
  }

  @ApiOperation({ summary: "Get unread notification count" })
  @Get("notifications/unread-count")
  getUnreadCount(@Req() req: AccountRequest) {
    return this.notifications.getUnreadCount(req.authUser!.id);
  }

  @ApiOperation({ summary: "Mark a notification as read" })
  @Patch("notifications/:id/read")
  markAsRead(@Req() req: AccountRequest, @Param("id") id: string) {
    return this.notifications.markAsRead(req.authUser!.id, id);
  }

  @ApiOperation({ summary: "Mark all notifications as read" })
  @Patch("notifications/mark-all-read")
  markAllRead(@Req() req: AccountRequest) {
    return this.notifications.markAllRead(req.authUser!.id);
  }

  @ApiOperation({ summary: "Archive a notification" })
  @Patch("notifications/:id/archive")
  archive(@Req() req: AccountRequest, @Param("id") id: string) {
    return this.notifications.archive(req.authUser!.id, id);
  }

  // ── Password ───────────────────────────────────────────────────────────────

  @ApiOperation({ summary: "Change account password" })
  @Patch("change-password")
  changePassword(@Req() req: AccountRequest, @Body() body: ChangePasswordDto) {
    return this.passwords.changePassword(
      req.authUser!.id,
      body.current_password,
      body.new_password,
    );
  }

  // ── Preferences ────────────────────────────────────────────────────────────

  @ApiOperation({ summary: "Get cleaning preferences (reminders, access instructions)" })
  @Get("preferences/cleaning")
  getCleaningPreferences(@Req() req: AccountRequest) {
    return this.preferences.getPreferences(req.authUser!.id);
  }

  @ApiOperation({ summary: "Update cleaning preferences" })
  @Put("preferences/cleaning")
  updateCleaningPreferences(@Req() req: AccountRequest, @Body() body: UpdatePreferencesDto) {
    return this.preferences.updatePreferences(req.authUser!.id, body);
  }

  // ── Admin access check ────────────────────────────────────────────────────

  @ApiOperation({ summary: "Check if the current user has any admin RBAC role" })
  @Get("is-admin")
  async isAdmin(@Req() req: AccountRequest) {
    return this.payment.checkAdminRole(req.authUser!.id);
  }

  // ── Payment ────────────────────────────────────────────────────────────────

  @ApiOperation({ summary: "Generate or fetch a Lightning invoice for a pending subscription (user-facing)" })
  @Post("subscriptions/:id/invoice")
  getSubscriptionInvoice(@Req() req: AccountRequest, @Param("id") subscriptionId: string) {
    return this.payment.createInvoice(req.authUser!.id, subscriptionId);
  }

}
