import { ApiProperty, ApiPropertyOptional } from "@nestjs/swagger";
import { ArrayNotEmpty, IsArray, IsBoolean, IsDateString, IsEmail, IsIn, IsInt, IsOptional, IsString, Min, MinLength } from "class-validator";

const weekdays = ["MONDAY", "TUESDAY", "WEDNESDAY", "THURSDAY", "FRIDAY", "SATURDAY", "SUNDAY"] as const;
const clientStatuses = ["active", "inactive", "paused", "cancelled", "archived"] as const;
const billingTypes = ["daily", "weekly", "monthly", "custom"] as const;
const paymentTimings = ["prepaid", "after_service_completed", "custom_terms"] as const;
const scheduleStatuses = ["active", "paused", "cancelled", "archived"] as const;
const bookingStatuses = ["booked", "completed", "cancelled"] as const;

export class CreateCustomCleaningPlanDto {
  @ApiPropertyOptional({ example: "client_123", description: "Existing cleaning client id to reuse instead of creating a new client." })
  @IsOptional()
  @IsString()
  existingClientId?: string;

  @ApiProperty({ example: "Infinita Cowork" })
  @IsString()
  @MinLength(1)
  companyName!: string;

  @ApiPropertyOptional({ example: "Operations Manager" })
  @IsOptional()
  @IsString()
  contactPerson?: string;

  @ApiPropertyOptional({ example: "client@example.com" })
  @IsOptional()
  @IsEmail()
  email?: string;

  @ApiPropertyOptional({ example: "+504 0000 0000" })
  @IsOptional()
  @IsString()
  phone?: string;

  @ApiProperty({ example: "Duna Tower Level 1" })
  @IsString()
  @MinLength(1)
  location!: string;

  @ApiPropertyOptional({ example: "Daily cowork cleaning" })
  @IsOptional()
  @IsString()
  serviceType?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  notes?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  internalAdminNotes?: string;

  @ApiProperty({ example: "2026-05-18" })
  @IsDateString()
  startDate!: string;

  @ApiPropertyOptional({ example: "2026-08-18" })
  @IsOptional()
  @IsDateString()
  endDate?: string;

  @ApiProperty({ enum: clientStatuses, example: "active" })
  @IsIn(clientStatuses)
  status!: typeof clientStatuses[number];

  @ApiProperty({ example: "Infinita Cowork Daily Cleaning" })
  @IsString()
  @MinLength(1)
  planName!: string;

  @ApiProperty({ example: 1000, description: "Custom plan price in cents." })
  @IsInt()
  @Min(0)
  customPriceCents!: number;

  @ApiProperty({ enum: billingTypes, example: "daily" })
  @IsIn(billingTypes)
  billingType!: typeof billingTypes[number];

  @ApiProperty({ example: true })
  @IsBoolean()
  monthlyInvoice!: boolean;

  @ApiProperty({ enum: paymentTimings, example: "after_service_completed" })
  @IsIn(paymentTimings)
  paymentTiming!: typeof paymentTimings[number];

  @ApiPropertyOptional({ example: "Monthly invoice after services are completed" })
  @IsOptional()
  @IsString()
  customTerms?: string;

  @ApiPropertyOptional({ example: "6 days per week" })
  @IsOptional()
  @IsString()
  serviceFrequency?: string;

  @ApiProperty({ enum: weekdays, isArray: true, example: ["MONDAY", "TUESDAY", "WEDNESDAY", "THURSDAY", "FRIDAY", "SATURDAY"] })
  @IsArray()
  @ArrayNotEmpty()
  @IsIn(weekdays, { each: true })
  daysOfWeek!: Array<typeof weekdays[number]>;

  @ApiProperty({ example: true })
  @IsBoolean()
  deepCleaningAddOn!: boolean;

  @ApiPropertyOptional({ example: 24000 })
  @IsOptional()
  @IsInt()
  @Min(0)
  estimatedMonthlyTotalCents?: number;

  @ApiPropertyOptional({ type: [String] })
  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  dailyChecklist?: string[];

  @ApiPropertyOptional({ type: [String] })
  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  deepCleaningChecklist?: string[];

  @ApiProperty({ example: "08:00" })
  @IsString()
  preferredStartTime!: string;

  @ApiProperty({ example: "10:00" })
  @IsString()
  preferredEndTime!: string;

  @ApiPropertyOptional({ example: "Cleaner A" })
  @IsOptional()
  @IsString()
  assignedCleaner?: string;

  @ApiProperty({ example: 120 })
  @IsInt()
  @Min(15)
  serviceDurationMinutes!: number;

  @ApiPropertyOptional({ example: "weekly" })
  @IsOptional()
  @IsString()
  repeatFrequency?: string;
}

export class UpdateCleaningClientStatusDto {
  @ApiProperty({ enum: clientStatuses })
  @IsIn(clientStatuses)
  status!: typeof clientStatuses[number];
}

export class UpdateCleaningClientDto {
  @ApiProperty({ example: "Infinita Cowork" })
  @IsString()
  @MinLength(1)
  companyName!: string;

  @ApiPropertyOptional({ example: "Operations Manager" })
  @IsOptional()
  @IsString()
  contactPerson?: string;

  @ApiPropertyOptional({ example: "client@example.com" })
  @IsOptional()
  @IsEmail()
  email?: string;

  @ApiPropertyOptional({ example: "+504 0000 0000" })
  @IsOptional()
  @IsString()
  phone?: string;

  @ApiProperty({ example: "Duna Tower Level 1" })
  @IsString()
  @MinLength(1)
  location!: string;

  @ApiPropertyOptional({ example: "Daily cowork cleaning" })
  @IsOptional()
  @IsString()
  serviceType?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  notes?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  internalAdminNotes?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  invoicePreferences?: string;

  @ApiProperty({ enum: clientStatuses, example: "active" })
  @IsIn(clientStatuses)
  status!: typeof clientStatuses[number];

  @ApiPropertyOptional({ example: "regular_cleaning_client" })
  @IsOptional()
  @IsString()
  clientType?: string;

  @ApiPropertyOptional({ example: "admin_only" })
  @IsOptional()
  @IsString()
  visibility?: string;

  @ApiPropertyOptional({ example: false })
  @IsOptional()
  @IsBoolean()
  isPrivate?: boolean;
}

export class UpdateRecurringScheduleStatusDto {
  @ApiProperty({ enum: scheduleStatuses })
  @IsIn(scheduleStatuses)
  status!: typeof scheduleStatuses[number];
}

export class CompleteCleaningBookingDto {
  @ApiPropertyOptional({ type: [String] })
  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  checklistCompleted?: string[];

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  notes?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  photoUrl?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  issueReport?: string;

  @ApiProperty({ example: "Admin" })
  @IsString()
  @MinLength(1)
  completedBy!: string;
}

/**
 * Booking details sent directly from the frontend (stored in localStorage).
 * Used when the backend database is unavailable and the booking cannot be
 * loaded from Prisma.
 */
export class DirectCalendarSyncDto {
  /** ISO-8601 date string, e.g. "2026-05-28" */
  @ApiProperty({ example: "2026-05-28" })
  @IsDateString()
  date!: string;

  /** HH:mm start time, e.g. "08:00" */
  @ApiProperty({ example: "08:00" })
  @IsString()
  startTime!: string;

  /** HH:mm end time, e.g. "10:00" */
  @ApiProperty({ example: "10:00" })
  @IsString()
  endTime!: string;

  @ApiPropertyOptional({ example: "Infinita City" })
  @IsOptional()
  @IsString()
  clientName?: string;

  @ApiPropertyOptional({ example: "Daily Cleaning" })
  @IsOptional()
  @IsString()
  planName?: string;

  @ApiPropertyOptional({ example: "Duna Tower Level 1" })
  @IsOptional()
  @IsString()
  location?: string;

  @ApiPropertyOptional({ example: "booked" })
  @IsOptional()
  @IsString()
  status?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  notes?: string;

  /** Existing Google Calendar event ID — provided for updates, omit for creates. */
  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  googleCalendarEventId?: string;
}

export class UpdateCleaningBookingDto {
  @ApiPropertyOptional({ enum: bookingStatuses, example: "cancelled" })
  @IsOptional()
  @IsIn(bookingStatuses)
  status?: typeof bookingStatuses[number];

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  notes?: string;

  @ApiPropertyOptional({ example: "Duna Tower Level 1" })
  @IsOptional()
  @IsString()
  location?: string;

  @ApiPropertyOptional({ example: "Cleaner A" })
  @IsOptional()
  @IsString()
  assignedCleaner?: string;

  @ApiPropertyOptional({ example: 120 })
  @IsOptional()
  @IsInt()
  @Min(15)
  serviceDurationMinutes?: number;
}
