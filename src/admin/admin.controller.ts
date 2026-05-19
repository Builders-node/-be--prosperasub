import { Body, Controller, Delete, Get, Param, Patch, Post, Req, UseGuards } from "@nestjs/common";
import { ApiBearerAuth, ApiOperation, ApiResponse, ApiTags } from "@nestjs/swagger";
import { CatalogService } from "../catalog/catalog.service";
import { AdminAuthGuard, type AdminRequest } from "./admin-auth.guard";
import {
  CompleteCleaningBookingDto,
  CreateCustomCleaningPlanDto,
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
    private readonly admin: AdminService
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

  @ApiOperation({ summary: "List private custom cleaning clients" })
  @ApiResponse({ status: 200, description: "Admin-only custom cleaning clients with private plans and bookings." })
  @Get("cleaning/custom-clients")
  listCustomCleaningClients() {
    return this.admin.listCustomCleaningClients();
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
}
