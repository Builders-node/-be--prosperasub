import { Body, Controller, Delete, Get, Param, Patch, Post, Put, Query, Req, UseGuards } from "@nestjs/common";
import { ApiBearerAuth, ApiOperation, ApiProperty, ApiQuery, ApiTags } from "@nestjs/swagger";
import { IsBoolean, IsInt, IsOptional, IsString, Min, MinLength } from "class-validator";
import { AccountAuthGuard, type AccountRequest } from "./account-auth.guard";
import { AccountNotificationsService } from "./account-notifications.service";
import { AccountPasswordService } from "./account-password.service";
import { AccountPreferencesService } from "./account-preferences.service";
import { AccountCancellationService } from "./account-cancellation.service";
import { ProviderPayoutsService } from "./provider-payouts.service";
import { OccurrencesService } from "./occurrences.service";
import { ProviderMembersService } from "./provider-members.service";
import { ReviewPromptsService } from "./review-prompts.service";
import { AccountPaymentService } from "./account-payment.service";
import { AccountCleaningService } from "./account-cleaning.service";
import { AccountLocationsService } from "./account-locations.service";
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

class OccurrenceStatusDto {
  @ApiProperty({ enum: ["scheduled", "done", "failed", "cancelled"] })
  @IsString()
  status!: string;

  @ApiProperty({ required: false, nullable: true, description: "Why it failed — shown on the day's list." })
  @IsOptional()
  @IsString()
  reason?: string | null;
}

class OccurrenceAnnotateDto {
  @ApiProperty({ required: false, nullable: true, description: "Who is doing it." })
  @IsOptional()
  @IsString()
  assignee?: string | null;

  @ApiProperty({ required: false, nullable: true })
  @IsOptional()
  @IsString()
  notes?: string | null;
}

class OccurrenceRescheduleDto {
  @ApiProperty({ example: "2026-08-20T11:00:00.000Z" })
  @IsString()
  startsAt!: string;
}

class OccurrenceCompletionDto {
  @ApiProperty({ required: false, nullable: true })
  @IsOptional()
  checklist?: unknown;

  @ApiProperty({ required: false, nullable: true })
  @IsOptional()
  @IsString()
  photoUrl?: string | null;

  @ApiProperty({ required: false, nullable: true })
  @IsOptional()
  @IsString()
  issue?: string | null;

  @ApiProperty({ required: false, nullable: true })
  @IsOptional()
  @IsString()
  completedBy?: string | null;
}

class AddProviderMemberDto {
  @ApiProperty({ required: false, description: "users.id of the person, when picked from the user list." })
  @IsOptional()
  @IsString()
  userId?: string;

  @ApiProperty({ required: false, description: "Their email — resolved to an account server-side." })
  @IsOptional()
  @IsString()
  userEmail?: string;

  @ApiProperty({ required: false, description: "Display name for the team list." })
  @IsOptional()
  @IsString()
  userName?: string;
}

class SetProviderOwnerDto {
  @ApiProperty({ required: false, nullable: true, description: "users.id of the new owner; null hands it back to the platform." })
  @IsOptional()
  @IsString()
  userId?: string | null;
}

class RequestPayoutDto {
  @ApiProperty({ example: 25000, description: "Cents. Capped server-side by what the business earned." })
  @IsInt()
  @Min(1)
  amountCents!: number;

  @ApiProperty({ example: "provider@walletofsatoshi.com", description: "Lightning address or on-chain BTC address." })
  @IsString()
  @MinLength(4)
  destination!: string;

  @ApiProperty({ required: false })
  @IsOptional()
  @IsString()
  note?: string;
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
    private readonly cancellation: AccountCancellationService,
    private readonly payouts: ProviderPayoutsService,
    private readonly occurrences: OccurrencesService,
    private readonly members: ProviderMembersService,
    private readonly reviewPrompts: ReviewPromptsService,
    private readonly locations: AccountLocationsService,
  ) {}

  // ── Saved locations (home addresses — server-only, owner-scoped) ─────────────

  @ApiOperation({ summary: "List the current user's saved locations" })
  @Get("locations")
  listLocations(@Req() req: AccountRequest) {
    return this.locations.list(req.authUser!.id);
  }

  @ApiOperation({ summary: "Add a saved location for the current user" })
  @Post("locations")
  createLocation(@Req() req: AccountRequest, @Body() body: Record<string, unknown>) {
    return this.locations.create(req.authUser!.id, body);
  }

  @ApiOperation({ summary: "Update one of the current user's saved locations" })
  @Patch("locations/:id")
  updateLocation(@Req() req: AccountRequest, @Param("id") id: string, @Body() body: Record<string, unknown>) {
    return this.locations.update(req.authUser!.id, id, body);
  }

  @ApiOperation({ summary: "Delete one of the current user's saved locations" })
  @Delete("locations/:id")
  deleteLocation(@Req() req: AccountRequest, @Param("id") id: string) {
    return this.locations.remove(req.authUser!.id, id);
  }

  @ApiOperation({ summary: "Mark one of the current user's saved locations as default" })
  @Post("locations/:id/default")
  setDefaultLocation(@Req() req: AccountRequest, @Param("id") id: string) {
    return this.locations.setDefault(req.authUser!.id, id);
  }

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

  // ── Cancellation ───────────────────────────────────────────────────────────
  // One pair of routes for all four services. `service` is cleaning | food |
  // beach | plan; the service layer maps it to a table and its status column,
  // and refuses anything it does not recognise.

  @ApiOperation({ summary: "Stop a subscription renewing at the end of the paid period" })
  @Post(":service/subscriptions/:id/cancel")
  cancelSubscription(
    @Req() req: AccountRequest,
    @Param("service") service: string,
    @Param("id") subscriptionId: string,
  ) {
    return this.cancellation.cancel(req.authUser!.id, service, subscriptionId, req.authUser!.email);
  }

  @ApiOperation({ summary: "Undo a cancellation while the period is still running" })
  @Post(":service/subscriptions/:id/resume")
  resumeSubscription(
    @Req() req: AccountRequest,
    @Param("service") service: string,
    @Param("id") subscriptionId: string,
  ) {
    return this.cancellation.resume(req.authUser!.id, service, subscriptionId, req.authUser!.email);
  }


  /**
   * What this business has been paid.
   *
   * `provider_payouts` has RLS on with no policies, so the browser's anon key
   * gets nothing from it — this endpoint is the only way a provider sees the
   * ledger, and it checks ownership before answering.
   */
  @ApiOperation({ summary: "Payouts recorded for a business you own" })
  @Get("providers/:providerId/payouts")
  listProviderPayouts(
    @Req() req: AccountRequest,
    @Param("providerId") providerId: string,
  ) {
    const isAdmin = (req.authUser?.roles ?? []).includes("SUPER_ADMIN");
    return this.payouts.listForOwner(req.authUser!.id, providerId, isAdmin);
  }

  /**
   * The provider's day — visits, deliveries and booked hours in one list,
   * whatever the service. See OccurrencesService for why the writes still go
   * to the legacy row where one exists.
   */
  @ApiOperation({ summary: "Occurrences for a business you run, in a date window" })
  @Get("providers/:providerId/occurrences")
  listOccurrences(
    @Req() req: AccountRequest,
    @Param("providerId") providerId: string,
    @Query("from") from?: string,
    @Query("to") to?: string,
    @Query("status") status?: string,
  ) {
    const isAdmin = (req.authUser?.roles ?? []).includes("SUPER_ADMIN");
    return this.occurrences.list(req.authUser!.id, providerId, isAdmin, { from, to, status });
  }

  @ApiOperation({ summary: "Schedule the days ahead that nobody has generated yet" })
  @Post("providers/:providerId/occurrences/generate")
  generateOccurrences(@Req() req: AccountRequest, @Param("providerId") providerId: string) {
    const isAdmin = (req.authUser?.roles ?? []).includes("SUPER_ADMIN");
    return this.occurrences.generate(req.authUser!.id, providerId, isAdmin);
  }

  @ApiOperation({ summary: "Mark an occurrence done, failed or cancelled" })
  @Patch("occurrences/:id/status")
  setOccurrenceStatus(@Req() req: AccountRequest, @Param("id") id: string, @Body() body: OccurrenceStatusDto) {
    const isAdmin = (req.authUser?.roles ?? []).includes("SUPER_ADMIN");
    return this.occurrences.setStatus(req.authUser!.id, id, isAdmin, { status: body.status, reason: body.reason });
  }

  @ApiOperation({ summary: "Assign someone to an occurrence, or note something on it" })
  @Patch("occurrences/:id")
  annotateOccurrence(@Req() req: AccountRequest, @Param("id") id: string, @Body() body: OccurrenceAnnotateDto) {
    const isAdmin = (req.authUser?.roles ?? []).includes("SUPER_ADMIN");
    return this.occurrences.annotate(req.authUser!.id, id, isAdmin, body);
  }

  @ApiOperation({ summary: "Move an occurrence to another time" })
  @ApiOperation({ summary: "Remove an occurrence — cancels what it holds, then deletes it" })
  @Delete("occurrences/:id")
  removeOccurrence(@Req() req: AccountRequest, @Param("id") id: string) {
    const isAdmin = (req.authUser?.roles ?? []).includes("SUPER_ADMIN");
    return this.occurrences.remove(req.authUser!.id, id, isAdmin);
  }

  @Post("occurrences/:id/reschedule")
  rescheduleOccurrence(@Req() req: AccountRequest, @Param("id") id: string, @Body() body: OccurrenceRescheduleDto) {
    const isAdmin = (req.authUser?.roles ?? []).includes("SUPER_ADMIN");
    return this.occurrences.reschedule(req.authUser!.id, id, isAdmin, body.startsAt);
  }

  @ApiOperation({ summary: "File a completion report and mark it done" })
  @Post("occurrences/:id/completion")
  completeOccurrence(@Req() req: AccountRequest, @Param("id") id: string, @Body() body: OccurrenceCompletionDto) {
    const isAdmin = (req.authUser?.roles ?? []).includes("SUPER_ADMIN");
    return this.occurrences.complete(req.authUser!.id, id, isAdmin, body);
  }

  /**
   * Who runs a business.
   *
   * These four used to be direct writes from the Team tab. `provider_members`
   * is what decides whether somebody may see a provider's day — addresses and
   * all — and `providers.admin_user_id` is what the payout endpoint calls
   * ownership, so with a world-writable table the anon key was enough to
   * become either. The table now refuses anon writes and this is the door.
   */
  /**
   * What this customer could rate.
   *
   * The rating widget has been on every subscription card for months and has
   * collected one review — because nothing ever asked. This is the ask: a job
   * that finished in the last month, for a business they have not rated.
   */
  @ApiOperation({ summary: "Finished jobs this customer has not rated yet" })
  @Get("reviews/pending")
  pendingReviews(@Req() req: AccountRequest) {
    return this.reviewPrompts.pending(req.authUser!.id);
  }

  @ApiOperation({ summary: "Who runs a business you own" })
  @Get("providers/:providerId/members")
  listProviderMembers(@Req() req: AccountRequest, @Param("providerId") providerId: string) {
    const isAdmin = (req.authUser?.roles ?? []).includes("SUPER_ADMIN");
    return this.members.list(req.authUser!.id, providerId, isAdmin);
  }

  @ApiOperation({ summary: "Add a manager to a business you own" })
  @Post("providers/:providerId/members")
  addProviderMember(
    @Req() req: AccountRequest,
    @Param("providerId") providerId: string,
    @Body() body: AddProviderMemberDto,
  ) {
    const isAdmin = (req.authUser?.roles ?? []).includes("SUPER_ADMIN");
    return this.members.add(req.authUser!.id, providerId, isAdmin, {
      userId: body.userId ?? null,
      userEmail: body.userEmail ?? null,
      userName: body.userName ?? null,
    });
  }

  @ApiOperation({ summary: "Remove a manager from a business you own" })
  @Delete("providers/:providerId/members/:memberId")
  removeProviderMember(
    @Req() req: AccountRequest,
    @Param("providerId") providerId: string,
    @Param("memberId") memberId: string,
  ) {
    const isAdmin = (req.authUser?.roles ?? []).includes("SUPER_ADMIN");
    return this.members.remove(req.authUser!.id, providerId, isAdmin, memberId);
  }

  @ApiOperation({ summary: "Hand a business you own to somebody else" })
  @Put("providers/:providerId/owner")
  setProviderOwner(
    @Req() req: AccountRequest,
    @Param("providerId") providerId: string,
    @Body() body: SetProviderOwnerDto,
  ) {
    const isAdmin = (req.authUser?.roles ?? []).includes("SUPER_ADMIN");
    return this.members.setOwner(req.authUser!.id, providerId, isAdmin, body.userId ?? null);
  }

  @ApiOperation({ summary: "What this business may withdraw right now" })
  @Get("providers/:providerId/payouts/available")
  providerPayoutAvailable(
    @Req() req: AccountRequest,
    @Param("providerId") providerId: string,
  ) {
    const isAdmin = (req.authUser?.roles ?? []).includes("SUPER_ADMIN");
    return this.payouts.available(req.authUser!.id, providerId, isAdmin);
  }

  /**
   * Ask to be paid. The amount is capped server-side against what the business
   * actually earned minus what it has already asked for — the figure the Money
   * tab shows is the same one, but a cap computed in a browser is a suggestion.
   */
  @ApiOperation({ summary: "Request a payout for a business you own" })
  @Post("providers/:providerId/payouts/request")
  requestProviderPayout(
    @Req() req: AccountRequest,
    @Param("providerId") providerId: string,
    @Body() body: RequestPayoutDto,
  ) {
    const isAdmin = (req.authUser?.roles ?? []).includes("SUPER_ADMIN");
    return this.payouts.request(
      {
        providerId,
        amountCents: body.amountCents,
        destination: body.destination,
        note: body.note ?? null,
      },
      req.authUser!.id,
      isAdmin,
    );
  }

}
