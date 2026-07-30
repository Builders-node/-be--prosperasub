import { Type } from "class-transformer";
import {
  IsEmail, IsInt, IsOptional, IsString, IsUUID, Max, MaxLength,
  Min, ValidateNested,
} from "class-validator";

export class CustomerDto {
  @IsEmail() @MaxLength(255) email!: string;
  @IsOptional() @IsString() @MaxLength(255) name?: string;
  @IsOptional() @IsString() @MaxLength(64)  whatsapp?: string;
}

export class FoodSubscriptionDto {
  @IsUUID() meal_plan_id!: string;
  @IsInt() @Min(1) @Max(52) weeks!: number;

  // YYYY-MM-DD in Honduras local time. If omitted, the server uses "today HN"
  // so Builders Node doesn't have to reason about time zones.
  @IsOptional() @IsString() @MaxLength(10) started_at?: string;

  @IsOptional() @IsString() @MaxLength(255) delivery_address?: string;
  @IsOptional() @IsString() @MaxLength(120) residence?: string;
  @IsOptional() @IsString() @MaxLength(2000) notes?: string;
}

export class CleaningSubscriptionDto {
  @IsUUID() package_id!: string;
  @IsInt() @Min(1) @Max(12) months!: number;

  @IsOptional() @IsString() @MaxLength(10) started_at?: string;
  @IsOptional() @IsString() @MaxLength(2000) apartment_note?: string;
  @IsOptional() @IsString() @MaxLength(2000) cleaner_hint?: string;
}

/**
 * Request body for `POST /integrations/builders-node/subscription`.
 *
 * `food` and `cleaning` are both optional but at least one must be present —
 * the controller enforces that at the top of its handler (a class-validator
 * cross-field constraint is more machinery than one `if` warrants).
 *
 * `external_ref` is Builders Node's row id for whatever they're mirroring.
 * We stamp it into `payment_reference` on our subscription rows so a retry
 * with the same ref returns the existing subscription instead of creating
 * a duplicate — poor man's idempotency without a schema change.
 */
export class ProvisionSubscriptionDto {
  @ValidateNested() @Type(() => CustomerDto)   customer!: CustomerDto;
  @IsOptional() @ValidateNested() @Type(() => FoodSubscriptionDto)     food?: FoodSubscriptionDto;
  @IsOptional() @ValidateNested() @Type(() => CleaningSubscriptionDto) cleaning?: CleaningSubscriptionDto;
  @IsOptional() @IsString() @MaxLength(120) external_ref?: string;
}

export interface ProvisionSubscriptionResponse {
  user_id: string;
  food_subscription_id: string | null;
  cleaning_subscription_id: string | null;
  /** Non-fatal issues — e.g. one leg failed but the user + other leg succeeded. */
  warnings: string[];
}
