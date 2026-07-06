import { Type } from "class-transformer";
import {
  IsArray,
  IsBoolean,
  IsDateString,
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  IsUUID,
  Max,
  MaxLength,
  Min,
  ValidateNested,
} from "class-validator";

/**
 * Field validators for admin subscription create/update endpoints.
 *
 * The service's `pickSubscriptionFields` still enforces the write-column
 * allow-list, so unknown extras are safely dropped by the service. These
 * decorators exist to reject malformed *values* (non-numeric prices,
 * unparseable dates, out-of-range enums) before they hit the database or
 * the reconciliation cron.
 */

const PAYMENT_STATUSES = ["pending", "paid", "failed", "refunded", "cancelled"] as const;
const SUBSCRIPTION_STATUSES = [
  "active", "paused", "cancelled", "expired", "pending", "inactive",
] as const;
const PAYMENT_METHODS = [
  "lightning", "onchain", "infinita", "crypto", "paypal", "free", "manual",
] as const;

export class AdminSubscriptionFieldsDto {
  @IsOptional() @IsUUID() user_id?: string;
  @IsOptional() @IsUUID() client_id?: string;
  @IsOptional() @IsUUID() package_id?: string;

  @IsOptional() @IsDateString() start_date?: string;
  @IsOptional() @IsDateString() end_date?: string;
  @IsOptional() @IsDateString() service_start_date?: string;
  @IsOptional() @IsDateString() service_end_date?: string;
  @IsOptional() @IsDateString() paid_until?: string;

  @IsOptional() @IsInt() @Min(1) @Max(120) billing_period_months?: number;
  @IsOptional() @IsInt() @Min(0) @Max(100_000_00) monthly_price_cents?: number;
  @IsOptional() @IsInt() @Min(0) @Max(1_000_000_00) total_price_cents?: number;
  @IsOptional() @IsInt() @Min(0) @Max(1000) cleanings_remaining?: number;

  @IsOptional() @IsIn(PAYMENT_STATUSES as unknown as string[]) payment_status?: string;
  @IsOptional() @IsIn(SUBSCRIPTION_STATUSES as unknown as string[]) subscription_status?: string;
  @IsOptional() @IsIn(PAYMENT_METHODS as unknown as string[]) payment_method?: string;

  @IsOptional() @IsString() @MaxLength(255) payment_reference?: string;

  @IsOptional() @IsInt() @Min(0) @Max(6) recurring_day_of_week?: number;
  @IsOptional() @IsString() @MaxLength(16) recurring_time?: string;

  @IsOptional() @IsString() @MaxLength(2000) apartment_note?: string;
  @IsOptional() @IsString() @MaxLength(2000) admin_notes?: string;

  @IsOptional() @IsBoolean() is_active?: boolean;
}

export class ReservationsDto {
  @IsOptional() @IsBoolean() enabled?: boolean;
  @IsOptional() @IsArray() @IsInt({ each: true }) @Min(0, { each: true }) @Max(6, { each: true })
  days_of_week?: number[];
  @IsOptional() @IsString() @MaxLength(16) start_time?: string;
  @IsOptional() @IsString() @MaxLength(16) end_time?: string;
  @IsOptional() @IsIn(["booking_reserved", "confirmed_booking"]) reservation_type?: string;
  @IsOptional() @IsBoolean() block_capacity?: boolean;
  @IsOptional() @IsBoolean() sync_calendar?: boolean;
  @IsOptional() @IsDateString() end_date?: string;
  @IsOptional() @IsString() @MaxLength(2000) notes?: string;
  @IsOptional() @IsIn(["weekly", "biweekly", "monthly_weeks"]) recurrence_type?: string;
  @IsOptional() @IsArray() @IsInt({ each: true }) @Min(-1, { each: true }) @Max(5, { each: true })
  weeks_of_month?: number[];
}

export class CreateAdminSubscriptionDto extends AdminSubscriptionFieldsDto {
  @IsOptional() @IsBoolean() one_time?: boolean;
}

export class UpdateAdminSubscriptionDto extends AdminSubscriptionFieldsDto {}

// PATCH /admin/subscriptions/:id ships { fields, action } — the fields object
// carries the actual column changes and `action` selects lifecycle behaviour.
export class UpdateAdminSubscriptionRequestDto {
  @IsOptional() @ValidateNested() @Type(() => UpdateAdminSubscriptionDto)
  fields?: UpdateAdminSubscriptionDto;
  @IsOptional() @IsIn(["edit", "update", "cancel", "renew", "reactivate", "pause", "resume"])
  action?: string;
}

export class CreateSubscriptionWithReservationsDto extends AdminSubscriptionFieldsDto {
  @IsOptional() @IsBoolean() one_time?: boolean;
  @IsOptional() @ValidateNested() @Type(() => ReservationsDto)
  reservations?: ReservationsDto;
}
