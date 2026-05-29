import { Body, Controller, Delete, Get, Param, Patch, Post, Query, Req, UseGuards } from "@nestjs/common";
import { ApiBearerAuth, ApiOperation, ApiResponse, ApiTags } from "@nestjs/swagger";
import { CatalogService } from "../catalog/catalog.service";
import { GoogleCalendarService } from "../google-calendar/google-calendar.service";
import { NotificationsService } from "../notifications/notifications.service";
import { AdminAuthGuard, type AdminRequest } from "./admin-auth.guard";
import {
  CompleteCleaningBookingDto,
  CreateCustomCleaningPlanDto,
  DirectCalendarSyncDto,
  UpdateCleaningBookingDto,
  UpdateCleaningClientDto,
  UpdateCleaningClientStatusDto,
  UpdateRecurringScheduleStatusDto,
} from "./admin-cleaning.dto";
import { AdminService } from "./admin.service";

@ApiTags("Admin")
@ApiBearerAuth()
@UseGuards(AdminAuthGuard)
@Controller("admin")
export class AdminController {
  constructor(
    private readonly catalog: CatalogService,
    private readonly admin: AdminService,
    private readonly notifications: NotificationsService,
    private readonly googleCalendar: GoogleCalendarService,
  ) {}

  @ApiOperation({ summary: "Get platform overview metrics" })
  @ApiResponse({ status: 200, description: "Global dashboard metrics." })
  @Get("overview")
  getOverview() {
    return this.catalog.getOverview();
  }

  @ApiOperation({ summary: "List platform users" })
  @ApiResponse({ status: 200, description: "Safe user records for the admin dashboard." })
  @Get("users")
  listUsers() {
    return this.admin.listUsers();
  }

  @ApiOperation({ summary: "List admin payment notification delivery statuses" })
  @ApiResponse({ status: 200, description: "Recent payment notifications sent to admins." })
  @Get("payment-notifications")
  listPaymentNotifications() {
    return this.notifications.listAdminPaymentNotifications();
  }

  @ApiOperation({ summary: "Resend admin email and Telegram notifications for a payment" })
  @ApiResponse({ status: 201, description: "Notification resend attempted." })
  @Post("payment-notifications/:id/resend")
  resendPaymentNotification(@Param("id") id: string) {
    return this.notifications.resendAdminPaymentNotification(id);
  }

  // ─── Telegram ────────────────────────────────────────────────────────────

  @ApiOperation({ summary: "Send a test Telegram notification to verify bot configuration" })
  @ApiResponse({ status: 201, description: "Result of the test Telegram message attempt." })
  @Post("telegram/test")
  testTelegramNotification() {
    return this.notifications.sendTelegramTest();
  }

  @ApiOperation({ summary: "Retrieve recent Telegram bot updates (messages sent to the bot)" })
  @ApiResponse({ status: 200, description: "List of chats that have messaged the bot. Use to find the admin chat_id." })
  @Get("telegram/updates")
  getTelegramUpdates() {
    return this.notifications.getTelegramBotUpdates();
  }

  // ─── Google Calendar OAuth2 setup ───────────────────────────────────────

  @ApiOperation({ summary: "Get Google Calendar configuration status" })
  @ApiResponse({ status: 200, description: "Current Google Calendar auth configuration." })
  @Get("google-calendar/status")
  getGoogleCalendarStatus() {
    return {
      configured: this.googleCalendar.isConfigured(),
      calendarId: this.googleCalendar.getSharedAdminCleaningCalendarId(),
      ...this.googleCalendar.getConfigurationStatus(),
    };
  }

  @ApiOperation({ summary: "Test the Google Calendar API connection (no DB required)" })
  @ApiResponse({ status: 200, description: "Result of fetching the calendar metadata from Google API." })
  @Get("google-calendar/test")
  testGoogleCalendarConnection() {
    return this.googleCalendar.testConnection();
  }

  @ApiOperation({ summary: "Get Google OAuth2 authorization URL for calendar access" })
  @ApiResponse({ status: 200, description: "Authorization URL to open in a browser to grant calendar access." })
  @Get("google-calendar/oauth-url")
  getGoogleCalendarOAuthUrl(@Query("redirect_uri") redirectUri?: string) {
    const callbackUri = redirectUri ?? "https://api.prosperasub.com/auth/calendar/callback";
    const url = this.googleCalendar.getOAuthAuthorizationUrl(callbackUri);
    return {
      authorizationUrl: url,
      instructions: [
        "1. Open the authorizationUrl in your browser.",
        "2. Sign in with the Google account that owns the calendar.",
        "3. Click 'Allow' to grant calendar access.",
        `4. You will be redirected to: ${callbackUri}?code=XXXX`,
        "5. Copy the 'code' parameter value.",
        "6. Call POST /admin/google-calendar/exchange-code with { code, redirect_uri }.",
        "7. Copy the returned refresh_token and set it as GOOGLE_CALENDAR_REFRESH_TOKEN in Vercel.",
      ],
    };
  }

  @ApiOperation({ summary: "Exchange a Google OAuth2 authorization code for a refresh token" })
  @ApiResponse({ status: 201, description: "Access and refresh tokens. Save the refresh_token as GOOGLE_CALENDAR_REFRESH_TOKEN in Vercel env vars." })
  @Post("google-calendar/exchange-code")
  exchangeGoogleOAuthCode(@Body() body: { code: string; redirect_uri?: string }) {
    const redirectUri = body.redirect_uri ?? "https://api.prosperasub.com/auth/calendar/callback";
    return this.googleCalendar.exchangeOAuthCode(body.code, redirectUri);
  }

  // ─── Cleaning clients ────────────────────────────────────────────────────

  @ApiOperation({ summary: "List private custom cleaning clients" })
  @ApiResponse({ status: 200, description: "Admin-only custom cleaning clients with private plans and bookings." })
  @Get("cleaning/custom-clients")
  listCustomCleaningClients() {
    return this.admin.listCustomCleaningClients();
  }

  @ApiOperation({ summary: "List all cleaning clients" })
  @ApiResponse({ status: 200, description: "Regular public clients and private custom cleaning clients for admin management." })
  @Get("clients")
  listCleaningClients() {
    return this.admin.listCleaningClients();
  }

  @ApiOperation({ summary: "Update a cleaning client profile" })
  @ApiResponse({ status: 200, description: "Updated cleaning client profile." })
  @Patch("clients/:id")
  updateCleaningClient(@Param("id") id: string, @Body() body: UpdateCleaningClientDto) {
    return this.admin.updateCleaningClient(id, body);
  }

  @ApiOperation({ summary: "List private custom cleaning plans" })
  @ApiResponse({ status: 200, description: "Admin-only custom cleaning plans. Public users never receive these records." })
  @Get("cleaning/custom-plans")
  listCustomCleaningPlans() {
    return this.admin.listCustomCleaningPlans();
  }

  @ApiOperation({ summary: "List cleaning bookings for admin operations" })
  @ApiResponse({ status: 200, description: "Public and private cleaning bookings for the admin dashboard." })
  @Get("cleaning/bookings")
  listCleaningBookings() {
    return this.admin.listCleaningBookings();
  }

  @ApiOperation({ summary: "List cleaning completion reports" })
  @ApiResponse({ status: 200, description: "Completion reports with checklist, notes, issues, and photo links." })
  @Get("cleaning/completion-reports")
  listCleaningCompletionReports() {
    return this.admin.listCleaningCompletionReports();
  }

  @ApiOperation({ summary: "Create a private custom cleaning client plan and recurring bookings" })
  @ApiResponse({ status: 201, description: "Private client, private plan, recurring schedule, checklist templates, and generated bookings." })
  @Post("cleaning/custom-plans")
  createCustomCleaningPlan(@Body() body: CreateCustomCleaningPlanDto, @Req() request: AdminRequest) {
    return this.admin.createCustomCleaningPlan(body, request.adminUser!.id);
  }

  @ApiOperation({ summary: "Update private cleaning client status" })
  @ApiResponse({ status: 200, description: "Updated private cleaning client." })
  @Patch("cleaning/custom-clients/:id")
  updateCleaningClientStatus(@Param("id") id: string, @Body() body: UpdateCleaningClientStatusDto) {
    return this.admin.updateCleaningClientStatus(id, body);
  }

  @ApiOperation({ summary: "Delete a private cleaning client and related private records" })
  @ApiResponse({ status: 200, description: "Private cleaning client deleted." })
  @Delete("cleaning/custom-clients/:id")
  deleteCleaningClient(@Param("id") id: string) {
    return this.admin.deleteCleaningClient(id);
  }

  @ApiOperation({ summary: "Pause, resume, cancel, or archive a recurring cleaning schedule" })
  @ApiResponse({ status: 200, description: "Updated recurring cleaning schedule." })
  @Patch("cleaning/recurring-schedules/:id")
  updateRecurringScheduleStatus(@Param("id") id: string, @Body() body: UpdateRecurringScheduleStatusDto) {
    return this.admin.updateRecurringScheduleStatus(id, body);
  }

  @ApiOperation({ summary: "Complete a booked cleaning session" })
  @ApiResponse({ status: 201, description: "Completion report created and booking marked completed." })
  @Post("cleaning/bookings/:id/complete")
  completeCleaningBooking(@Param("id") id: string, @Body() body: CompleteCleaningBookingDto) {
    return this.admin.completeCleaningBooking(id, body);
  }

  @ApiOperation({ summary: "Update a cleaning booking and sync Google Calendar" })
  @ApiResponse({ status: 200, description: "Updated booking plus Google Calendar sync result." })
  @Patch("cleaning/bookings/:id")
  updateCleaningBooking(@Param("id") id: string, @Body() body: UpdateCleaningBookingDto) {
    return this.admin.updateCleaningBooking(id, body);
  }

  @ApiOperation({ summary: "Sync all cleaning bookings to the shared admin Google Calendar" })
  @ApiResponse({ status: 201, description: "Bulk sync result for backend-saved cleaning bookings." })
  @Post("cleaning/bookings/sync-calendar")
  syncAllCleaningBookingsCalendar() {
    return this.admin.syncAllCleaningBookingsCalendar();
  }

  @ApiOperation({ summary: "Sync a booking to Google Calendar using data provided directly (no DB needed)" })
  @ApiResponse({ status: 201, description: "Calendar event created or updated. Returns googleCalendarEventId and link." })
  @Post("cleaning/bookings/:id/sync-direct")
  syncCleaningBookingDirect(@Param("id") id: string, @Body() body: DirectCalendarSyncDto) {
    return this.admin.syncBookingFromData(id, body);
  }

  @ApiOperation({ summary: "Manually sync a cleaning booking to Google Calendar" })
  @ApiResponse({ status: 200, description: "Google Calendar sync result." })
  @Post("cleaning/bookings/:id/sync-calendar")
  syncCleaningBookingCalendar(@Param("id") id: string) {
    return this.admin.syncCleaningBookingCalendar(id);
  }

  @ApiOperation({ summary: "Delete a cleaning booking and its Google Calendar event" })
  @ApiResponse({ status: 200, description: "Booking and calendar event deleted." })
  @Delete("cleaning/bookings/:id")
  deleteCleaningBooking(@Param("id") id: string) {
    return this.admin.deleteCleaningBooking(id);
  }
}
