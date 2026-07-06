import { Body, Controller, Delete, Get, Param, Patch, Post, Query, Req, UseGuards, UsePipes, ValidationPipe } from "@nestjs/common";

// Lenient pipe for the subscription mutation endpoints. The global pipe uses
// `forbidNonWhitelisted: true` which would 400 on any extra field, but the
// service already runs its own SUBSCRIPTION_WRITE_COLUMNS allow-list — we just
// want *typed* fields validated (dates parse, numbers non-negative, enums
// correct) and everything else to pass through unchanged.
const AdminSubscriptionValidation = new ValidationPipe({
  whitelist: false,
  forbidNonWhitelisted: false,
  transform: true,
  skipMissingProperties: true,
});
import { ApiBearerAuth, ApiOperation, ApiResponse, ApiTags } from "@nestjs/swagger";
import { CatalogService } from "../catalog/catalog.service";
import { GoogleCalendarService } from "../google-calendar/google-calendar.service";
import { NotificationsService } from "../notifications/notifications.service";
import { AdminAuthGuard, type AdminRequest } from "./admin-auth.guard";
import { AdminPermission, RequireAdminPermission } from "./admin-permissions";
import { AdminRbacService } from "./admin-rbac.service";
import { AssignUserRolesDto, CreateRoleDto, UpdateRoleDto } from "./admin-roles.dto";
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
import {
  CreateAdminSubscriptionDto,
  CreateSubscriptionWithReservationsDto,
  UpdateAdminSubscriptionRequestDto,
} from "./dto/admin-subscription.dto";

@ApiTags("Admin")
@ApiBearerAuth()
@UseGuards(AdminAuthGuard)
@Controller("admin")
export class AdminController {
  constructor(
    private readonly catalog: CatalogService,
    private readonly admin: AdminService,
    private readonly rbac: AdminRbacService,
    private readonly notifications: NotificationsService,
    private readonly googleCalendar: GoogleCalendarService,
  ) {}

  @ApiOperation({ summary: "Get platform overview metrics" })
  @ApiResponse({ status: 200, description: "Global dashboard metrics." })
  @Get("overview")
  @RequireAdminPermission(AdminPermission.UsersRead)
  getOverview() {
    return this.catalog.getOverview();
  }

  @ApiOperation({ summary: "List platform users" })
  @ApiResponse({ status: 200, description: "Safe user records for the admin dashboard." })
  @Get("users")
  @RequireAdminPermission(AdminPermission.UsersRead)
  listUsers() {
    return this.admin.listUsersFull();
  }

  @ApiOperation({ summary: "Update a platform user" })
  @Patch("users/:id")
  @RequireAdminPermission(AdminPermission.UsersWrite)
  updateUser(@Param("id") id: string, @Body() body: { name?: string; display_name?: string }, @Req() request: AdminRequest) {
    return this.admin.updateUser(id, body, request.adminUser!.id);
  }

  @ApiOperation({ summary: "Block or unblock a platform user" })
  @Patch("users/:id/block")
  @RequireAdminPermission(AdminPermission.UsersWrite)
  setUserBlocked(@Param("id") id: string, @Body() body: { block?: boolean }, @Req() request: AdminRequest) {
    return this.admin.setUserBlocked(id, Boolean(body.block), request.adminUser!.id);
  }

  @ApiOperation({ summary: "Soft-delete a platform user" })
  @Delete("users/:id")
  @RequireAdminPermission(AdminPermission.UsersWrite)
  softDeleteUser(@Param("id") id: string, @Req() request: AdminRequest) {
    return this.admin.softDeleteUser(id, request.adminUser!.id);
  }

  @ApiOperation({ summary: "List recent admin audit events for a user" })
  @Get("users/:id/audit")
  @RequireAdminPermission(AdminPermission.UsersRead)
  listUserAudit(@Param("id") id: string) {
    return this.admin.listUserAuditLogs(id);
  }

  @ApiOperation({ summary: "List users available for admin assignments" })
  @Get("assignment-users")
  @RequireAdminPermission(AdminPermission.UsersRead)
  listUsersForAssignment() {
    return this.admin.listUsersForAssignment();
  }

  @ApiOperation({ summary: "List admin payment notification delivery statuses" })
  @ApiResponse({ status: 200, description: "Recent payment notifications sent to admins." })
  @Get("payment-notifications")
  @RequireAdminPermission(AdminPermission.PaymentsRead)
  listPaymentNotifications() {
    return this.notifications.listAdminPaymentNotifications();
  }

  @ApiOperation({ summary: "Resend admin email and Telegram notifications for a payment" })
  @ApiResponse({ status: 201, description: "Notification resend attempted." })
  @Post("payment-notifications/:id/resend")
  @RequireAdminPermission(AdminPermission.PaymentsWrite)
  resendPaymentNotification(@Param("id") id: string) {
    return this.notifications.resendAdminPaymentNotification(id);
  }

  @ApiOperation({ summary: "Get admin payment stats" })
  @Get("payment-stats")
  @RequireAdminPermission(AdminPermission.PaymentsRead)
  getPaymentStats() {
    return this.admin.getAdminPaymentStats();
  }

  @ApiOperation({ summary: "List admin cleaning subscriptions (paginated)" })
  @Get("subscriptions")
  @RequireAdminPermission(AdminPermission.SubscriptionsRead)
  listAdminSubscriptions(@Query() query: Record<string, string>) {
    return this.admin.listAdminSubscriptions({
      page: query.page, limit: query.limit,
      status: query.status, q: query.q,
      sortBy: query.sortBy, sortDir: query.sortDir,
    });
  }

  @ApiOperation({ summary: "Create an admin cleaning subscription" })
  @Post("subscriptions")
  @RequireAdminPermission(AdminPermission.SubscriptionsWrite)
  createAdminSubscription(
    @Body(AdminSubscriptionValidation) body: CreateAdminSubscriptionDto,
    @Req() request: AdminRequest,
  ) {
    return this.admin.createAdminSubscription(body as unknown as Record<string, unknown>, request.adminUser!.id);
  }

  @ApiOperation({ summary: "Get bookings/reservations for a subscription" })
  @Get("subscriptions/:id/bookings")
  @RequireAdminPermission(AdminPermission.SubscriptionsRead)
  getSubscriptionBookings(@Param("id") id: string) {
    return this.admin.getSubscriptionBookings(id);
  }

  @ApiOperation({ summary: "Create subscription with optional slot reservations" })
  @Post("subscriptions/with-reservations")
  @RequireAdminPermission(AdminPermission.SubscriptionsWrite)
  createSubscriptionWithReservations(
    @Body(AdminSubscriptionValidation) body: CreateSubscriptionWithReservationsDto,
    @Req() request: AdminRequest,
  ) {
    return this.admin.createSubscriptionWithReservations(
      body as unknown as Record<string, unknown>,
      request.adminUser!.id,
    );
  }

  @ApiOperation({ summary: "Update an admin cleaning subscription" })
  @Patch("subscriptions/:id")
  @RequireAdminPermission(AdminPermission.SubscriptionsWrite)
  updateAdminSubscription(
    @Param("id") id: string,
    @Body(AdminSubscriptionValidation) body: UpdateAdminSubscriptionRequestDto,
    @Req() request: AdminRequest,
  ) {
    return this.admin.updateAdminSubscription(
      id,
      (body.fields ?? {}) as unknown as Record<string, unknown>,
      body.action,
      request.adminUser!.id,
    );
  }

  @ApiOperation({ summary: "Cancel a subscription and all its future bookings (removes Google Calendar events)" })
  @Patch("subscriptions/:id/cancel")
  @RequireAdminPermission(AdminPermission.SubscriptionsWrite)
  cancelSubscription(@Param("id") id: string, @Req() request: AdminRequest) {
    return this.admin.cancelSubscription(id, request.adminUser!.id);
  }

  @ApiOperation({ summary: "Permanently delete a subscription, all its bookings, and Google Calendar events" })
  @Delete("subscriptions/:id")
  @RequireAdminPermission(AdminPermission.SubscriptionsWrite)
  deleteSubscription(@Param("id") id: string, @Req() request: AdminRequest) {
    return this.admin.deleteSubscription(id, request.adminUser!.id);
  }

  @ApiOperation({ summary: "Generate a payment invoice (Lightning or on-chain) for a subscription" })
  @ApiResponse({ status: 201, description: "Invoice created for the subscription." })
  @Post("subscriptions/:id/invoice")
  @RequireAdminPermission(AdminPermission.SubscriptionsWrite)
  createSubscriptionInvoice(@Param("id") id: string, @Body() body: { method?: "lightning" | "onchain" }) {
    return this.admin.createSubscriptionInvoice(id, body?.method === "onchain" ? "onchain" : "lightning");
  }

  @ApiOperation({ summary: "Send a payment reminder for a food subscription (in-app + email)" })
  @ApiResponse({ status: 201, description: "Reminder dispatched." })
  @Post("food/subscriptions/:id/payment-reminder")
  @RequireAdminPermission(AdminPermission.SubscriptionsWrite)
  sendFoodPaymentReminder(@Param("id") id: string) {
    return this.admin.sendFoodPaymentReminder(id);
  }

  @ApiOperation({ summary: "Send a payment reminder for a cleaning subscription (in-app + email)" })
  @Post("cleaning/subscriptions/:id/payment-reminder")
  @RequireAdminPermission(AdminPermission.SubscriptionsWrite)
  sendCleaningPaymentReminder(@Param("id") id: string) {
    return this.admin.sendCleaningPaymentReminder(id);
  }

  @ApiOperation({ summary: "Send a payment reminder for a beach club subscription (in-app + email)" })
  @Post("beach-club/subscriptions/:id/payment-reminder")
  @RequireAdminPermission(AdminPermission.SubscriptionsWrite)
  sendBeachPaymentReminder(@Param("id") id: string) {
    return this.admin.sendBeachPaymentReminder(id);
  }

  @ApiOperation({ summary: "Send payment reminders to all unpaid subscriptions of a service" })
  @Post(":service/payment-reminders/remind-unpaid")
  @RequireAdminPermission(AdminPermission.SubscriptionsWrite)
  remindAllUnpaid(@Param("service") service: string, @Body() body: { providerId?: string }) {
    const svc = service === "cleaning" ? "cleaning" : service === "beach-club" ? "beach" : "food";
    return this.admin.remindAllUnpaid(svc, body?.providerId);
  }

  @ApiOperation({ summary: "Pull external bookings from Google Calendar into a beach court" })
  @Post("beach-club/courts/:id/pull-google")
  @RequireAdminPermission(AdminPermission.SubscriptionsWrite)
  pullBeachCourtFromGoogle(@Param("id") id: string) {
    return this.admin.pullBeachCourtFromGoogle(id);
  }

  @ApiOperation({ summary: "Pull all beach courts from their Google Calendars (used by cron)" })
  @Post("beach-club/courts/pull-google-all")
  @RequireAdminPermission(AdminPermission.SubscriptionsWrite)
  pullAllBeachCourtsFromGoogle() {
    return this.admin.pullAllBeachCourtsFromGoogle();
  }

  @ApiOperation({ summary: "Sync a beach court booking to its court's Google Calendar" })
  @Post("beach-club/court-bookings/:id/sync-google")
  @RequireAdminPermission(AdminPermission.SubscriptionsWrite)
  syncBeachCourtBooking(@Param("id") id: string) {
    return this.admin.syncBeachCourtBookingCreated(id);
  }

  @ApiOperation({ summary: "Remove a beach court booking's Google Calendar event" })
  @Post("beach-club/court-bookings/:id/unsync-google")
  @RequireAdminPermission(AdminPermission.SubscriptionsWrite)
  unsyncBeachCourtBooking(
    @Param("id") id: string,
    @Body() body: { courtId: string; eventId: string | null },
  ) {
    return this.admin.syncBeachCourtBookingDeleted({ bookingId: id, courtId: body.courtId, eventId: body.eventId });
  }

  @ApiOperation({ summary: "List cleaning packages for admin forms" })
  @Get("subscription-packages")
  @RequireAdminPermission(AdminPermission.SubscriptionsRead)
  listAdminCleaningPackages() {
    return this.admin.listAdminCleaningPackages();
  }

  // ─── Telegram ────────────────────────────────────────────────────────────

  @ApiOperation({ summary: "Send a test Telegram notification to verify bot configuration" })
  @ApiResponse({ status: 201, description: "Result of the test Telegram message attempt." })
  @Post("telegram/test")
  @RequireAdminPermission(AdminPermission.AdminSettingsWrite)
  testTelegramNotification() {
    return this.notifications.sendTelegramTest();
  }

  @ApiOperation({ summary: "Get platform settings" })
  @Get("settings")
  @RequireAdminPermission(AdminPermission.AdminSettingsRead)
  getPlatformSettings() {
    return this.admin.getPlatformSettings();
  }

  @ApiOperation({ summary: "Update platform settings" })
  @Patch("settings")
  @RequireAdminPermission(AdminPermission.AdminSettingsWrite)
  updatePlatformSettings(@Body() body: Record<string, unknown>, @Req() request: AdminRequest) {
    return this.admin.updatePlatformSettings(body, request.adminUser!.id);
  }

  @ApiOperation({ summary: "Retrieve recent Telegram bot updates (messages sent to the bot)" })
  @ApiResponse({ status: 200, description: "List of chats that have messaged the bot. Use to find the admin chat_id." })
  @Get("telegram/updates")
  @RequireAdminPermission(AdminPermission.AdminSettingsRead)
  getTelegramUpdates() {
    return this.notifications.getTelegramBotUpdates();
  }

  // ─── Google Calendar OAuth2 setup ───────────────────────────────────────

  @ApiOperation({ summary: "Get Google Calendar configuration status" })
  @ApiResponse({ status: 200, description: "Current Google Calendar auth configuration." })
  @Get("google-calendar/status")
  @RequireAdminPermission(AdminPermission.AdminSettingsRead)
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
  @RequireAdminPermission(AdminPermission.AdminSettingsRead)
  testGoogleCalendarConnection() {
    return this.googleCalendar.testConnection();
  }

  @ApiOperation({ summary: "Get Google OAuth2 authorization URL for calendar access" })
  @ApiResponse({ status: 200, description: "Authorization URL to open in a browser to grant calendar access." })
  @Get("google-calendar/oauth-url")
  @RequireAdminPermission(AdminPermission.AdminSettingsWrite)
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
  @RequireAdminPermission(AdminPermission.AdminSettingsWrite)
  exchangeGoogleOAuthCode(@Body() body: { code: string; redirect_uri?: string }) {
    const redirectUri = body.redirect_uri ?? "https://api.prosperasub.com/auth/calendar/callback";
    return this.googleCalendar.exchangeOAuthCode(body.code, redirectUri);
  }

  // ─── Cleaning clients ────────────────────────────────────────────────────

  @ApiOperation({ summary: "Get slot capacity settings" })
  @ApiResponse({ status: 200, description: "Current slot capacity configuration." })
  @Get("slot-capacity")
  @RequireAdminPermission(AdminPermission.AdminSettingsRead)
  getSlotCapacity() {
    return this.admin.getSlotCapacitySettings();
  }

  @ApiOperation({ summary: "Update slot capacity settings and optionally apply to future slots" })
  @ApiResponse({ status: 200, description: "Slot capacity updated." })
  @Patch("slot-capacity")
  @RequireAdminPermission(AdminPermission.AdminSettingsWrite)
  updateSlotCapacity(
    @Body() body: { default_slot_capacity?: number; saturday_slot_capacity?: number; apply_to_future?: boolean },
    @Req() request: AdminRequest,
  ) {
    return this.admin.updateSlotCapacitySettings(body, request.adminUser!.id);
  }

  @ApiOperation({ summary: "Update capacity for a specific slot" })
  @Patch("slots/:id/capacity")
  @RequireAdminPermission(AdminPermission.BookingsWrite)
  updateSlotCapacityById(
    @Param("id") id: string,
    @Body() body: { max_bookings: number },
  ) {
    return this.admin.updateSlotCapacity(id, body.max_bookings);
  }

  @ApiOperation({ summary: "List private custom cleaning clients" })
  @ApiResponse({ status: 200, description: "Admin-only custom cleaning clients with private plans and bookings." })
  @Get("cleaning/custom-clients")
  @RequireAdminPermission(AdminPermission.ClientsRead)
  listCustomCleaningClients() {
    return this.admin.listCustomCleaningClients();
  }

  @ApiOperation({ summary: "List all cleaning clients" })
  @ApiResponse({ status: 200, description: "Regular public clients and private custom cleaning clients for admin management." })
  @Get("clients")
  @RequireAdminPermission(AdminPermission.ClientsRead)
  listCleaningClients() {
    return this.admin.listCleaningClients();
  }

  @ApiOperation({ summary: "List cleaning clients (simple, for dropdowns)" })
  @ApiResponse({ status: 200, description: "Lightweight client list for form dropdowns." })
  @Get("clients/simple")
  @RequireAdminPermission(AdminPermission.ClientsRead)
  listCleaningClientsSimple() {
    return this.admin.listCleaningClientsSimple();
  }

  @ApiOperation({ summary: "Update a cleaning client profile" })
  @ApiResponse({ status: 200, description: "Updated cleaning client profile." })
  @Patch("clients/:id")
  @RequireAdminPermission(AdminPermission.ClientsWrite)
  updateCleaningClient(@Param("id") id: string, @Body() body: UpdateCleaningClientDto) {
    return this.admin.updateCleaningClient(id, body);
  }

  @ApiOperation({ summary: "List private custom cleaning plans" })
  @ApiResponse({ status: 200, description: "Admin-only custom cleaning plans. Public users never receive these records." })
  @Get("cleaning/custom-plans")
  @RequireAdminPermission(AdminPermission.CleaningPlansRead)
  listCustomCleaningPlans() {
    return this.admin.listCustomCleaningPlans();
  }

  @ApiOperation({ summary: "List cleaning bookings for admin operations" })
  @ApiResponse({ status: 200, description: "Public and private cleaning bookings for the admin dashboard." })
  @Get("cleaning/bookings")
  @RequireAdminPermission(AdminPermission.BookingsRead)
  listCleaningBookings() {
    return this.admin.listCleaningBookings();
  }

  @ApiOperation({ summary: "List cleaning completion reports" })
  @ApiResponse({ status: 200, description: "Completion reports with checklist, notes, issues, and photo links." })
  @Get("cleaning/completion-reports")
  @RequireAdminPermission(AdminPermission.BookingsRead)
  listCleaningCompletionReports() {
    return this.admin.listCleaningCompletionReports();
  }

  @ApiOperation({ summary: "Create a private custom cleaning client plan and recurring bookings" })
  @ApiResponse({ status: 201, description: "Private client, private plan, recurring schedule, checklist templates, and generated bookings." })
  @Post("cleaning/custom-plans")
  @RequireAdminPermission(AdminPermission.CleaningPlansWrite)
  createCustomCleaningPlan(@Body() body: CreateCustomCleaningPlanDto, @Req() request: AdminRequest) {
    return this.admin.createCustomCleaningPlan(body, request.adminUser!.id);
  }

  @ApiOperation({ summary: "Update private cleaning client status" })
  @ApiResponse({ status: 200, description: "Updated private cleaning client." })
  @Patch("cleaning/custom-clients/:id")
  @RequireAdminPermission(AdminPermission.ClientsWrite)
  updateCleaningClientStatus(@Param("id") id: string, @Body() body: UpdateCleaningClientStatusDto) {
    return this.admin.updateCleaningClientStatus(id, body);
  }

  @ApiOperation({ summary: "Delete a private cleaning client and related private records" })
  @ApiResponse({ status: 200, description: "Private cleaning client deleted." })
  @Delete("cleaning/custom-clients/:id")
  @RequireAdminPermission(AdminPermission.ClientsWrite)
  deleteCleaningClient(@Param("id") id: string) {
    return this.admin.deleteCleaningClient(id);
  }

  @ApiOperation({ summary: "Pause, resume, cancel, or archive a recurring cleaning schedule" })
  @ApiResponse({ status: 200, description: "Updated recurring cleaning schedule." })
  @Patch("cleaning/recurring-schedules/:id")
  @RequireAdminPermission(AdminPermission.BookingsWrite)
  updateRecurringScheduleStatus(@Param("id") id: string, @Body() body: UpdateRecurringScheduleStatusDto) {
    return this.admin.updateRecurringScheduleStatus(id, body);
  }

  @ApiOperation({ summary: "Complete a booked cleaning session" })
  @ApiResponse({ status: 201, description: "Completion report created and booking marked completed." })
  @Post("cleaning/bookings/:id/complete")
  @RequireAdminPermission(AdminPermission.BookingsWrite)
  completeCleaningBooking(@Param("id") id: string, @Body() body: CompleteCleaningBookingDto) {
    return this.admin.completeCleaningBooking(id, body);
  }

  @ApiOperation({ summary: "Update a cleaning booking and sync Google Calendar" })
  @ApiResponse({ status: 200, description: "Updated booking plus Google Calendar sync result." })
  @Patch("cleaning/bookings/:id")
  @RequireAdminPermission(AdminPermission.BookingsWrite)
  updateCleaningBooking(@Param("id") id: string, @Body() body: UpdateCleaningBookingDto) {
    return this.admin.updateCleaningBooking(id, body);
  }

  @ApiOperation({ summary: "Sync all cleaning bookings to the shared admin Google Calendar" })
  @ApiResponse({ status: 201, description: "Bulk sync result for backend-saved cleaning bookings." })
  @Post("cleaning/bookings/sync-calendar")
  @RequireAdminPermission(AdminPermission.BookingsWrite)
  syncAllCleaningBookingsCalendar() {
    return this.admin.syncAllCleaningBookingsCalendar();
  }

  @ApiOperation({ summary: "Reconcile the shared cleaning calendar (remove orphaned events, fix dates, sync pending)" })
  @ApiResponse({ status: 201, description: "Reconcile summary: orphans deleted, mismatches re-synced, pending synced." })
  @Post("cleaning/calendar/reconcile")
  @RequireAdminPermission(AdminPermission.BookingsWrite)
  reconcileCleaningCalendar() {
    return this.admin.reconcileCleaningCalendar();
  }

  @ApiOperation({ summary: "Sync a booking to Google Calendar using data provided directly (no DB needed)" })
  @ApiResponse({ status: 201, description: "Calendar event created or updated. Returns googleCalendarEventId and link." })
  @Post("cleaning/bookings/:id/sync-direct")
  @RequireAdminPermission(AdminPermission.BookingsWrite)
  syncCleaningBookingDirect(@Param("id") id: string, @Body() body: DirectCalendarSyncDto) {
    return this.admin.syncBookingFromData(id, body);
  }

  @ApiOperation({ summary: "Manually sync a cleaning booking to Google Calendar" })
  @ApiResponse({ status: 200, description: "Google Calendar sync result." })
  @Post("cleaning/bookings/:id/sync-calendar")
  @RequireAdminPermission(AdminPermission.BookingsWrite)
  syncCleaningBookingCalendar(@Param("id") id: string) {
    return this.admin.syncCleaningBookingCalendar(id);
  }

  @ApiOperation({ summary: "Delete a cleaning booking and its Google Calendar event" })
  @ApiResponse({ status: 200, description: "Booking and calendar event deleted." })
  @Delete("cleaning/bookings/:id")
  @RequireAdminPermission(AdminPermission.BookingsWrite)
  deleteCleaningBooking(@Param("id") id: string) {
    return this.admin.deleteCleaningBooking(id);
  }

  @ApiOperation({ summary: "List roles" })
  @Get("roles")
  @RequireAdminPermission(AdminPermission.RoleManagementRead)
  listRoles() {
    return this.rbac.listRoles();
  }

  @ApiOperation({ summary: "List permissions" })
  @Get("permissions")
  @RequireAdminPermission(AdminPermission.RoleManagementRead)
  listPermissions() {
    return this.rbac.listPermissions();
  }

  @ApiOperation({ summary: "Create a role" })
  @Post("roles")
  @RequireAdminPermission(AdminPermission.RoleManagementWrite)
  createRole(@Body() body: CreateRoleDto, @Req() request: AdminRequest) {
    return this.rbac.createRole(body, request.adminUser!.id, request.adminUser!.roles);
  }

  @ApiOperation({ summary: "Update a role" })
  @Patch("roles/:id")
  @RequireAdminPermission(AdminPermission.RoleManagementWrite)
  updateRole(@Param("id") id: string, @Body() body: UpdateRoleDto, @Req() request: AdminRequest) {
    return this.rbac.updateRole(id, body, request.adminUser!.id, request.adminUser!.roles);
  }

  @ApiOperation({ summary: "Archive a role" })
  @Delete("roles/:id")
  @RequireAdminPermission(AdminPermission.RoleManagementWrite)
  archiveRole(@Param("id") id: string, @Req() request: AdminRequest) {
    return this.rbac.archiveRole(id, request.adminUser!.id, request.adminUser!.roles);
  }

  @ApiOperation({ summary: "List active roles for a user" })
  @Get("users/:id/roles")
  @RequireAdminPermission(AdminPermission.RoleManagementRead)
  listUserRoles(@Param("id") id: string) {
    return this.rbac.listUserRoles(id);
  }

  @ApiOperation({ summary: "Assign active roles to a user" })
  @Patch("users/:id/roles")
  @RequireAdminPermission(AdminPermission.RoleManagementWrite)
  assignUserRoles(@Param("id") id: string, @Body() body: AssignUserRolesDto, @Req() request: AdminRequest) {
    return this.rbac.assignUserRoles(id, body, request.adminUser!.id, request.adminUser!.roles);
  }

  @ApiOperation({ summary: "List role history for a user" })
  @Get("users/:id/role-history")
  @RequireAdminPermission(AdminPermission.RoleManagementRead)
  listUserRoleHistory(@Param("id") id: string) {
    return this.rbac.listUserRoleHistory(id);
  }
}
