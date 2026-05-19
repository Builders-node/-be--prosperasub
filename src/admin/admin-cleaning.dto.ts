import { ApiProperty, ApiPropertyOptional } from "@nestjs/swagger";
import { ArrayNotEmpty, IsArray, IsBoolean, IsDateString, IsEmail, IsIn, IsInt, IsOptional, IsString, Min, MinLength } from "class-validator";

const weekdays = ["MONDAY", "TUESDAY", "WEDNESDAY", "THURSDAY", "FRIDAY", "SATURDAY", "SUNDAY"] as const;
const clientStatuses = ["active", "paused", "cancelled", "archived"] as const;
const billingTypes = ["daily", "weekly", "monthly", "custom"] as const;
const paymentTimings = ["prepaid", "after_service_completed", "custom_terms"] as const;
const scheduleStatuses = ["active", "paused", "cancelled", "archived"] as const;

export class CreateCustomCleaningPlanDto {
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
