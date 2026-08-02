import { IsEmail, IsIn, IsOptional, IsString, IsUUID, MaxLength } from "class-validator";

/**
 * Request body for `POST /integrations/builders-node/bookings`.
 *
 * Identify the user by `user_id` (preferred — stored from a prior
 * `provisionSubscription` response) or by `email` (we look up in `users`,
 * 404 if unknown). At least one is required.
 *
 * `from` / `to` — optional YYYY-MM-DD (Honduras local). Server defaults to
 * "today → +90 days" to keep the response bounded. Historical bookings can
 * be pulled by setting `from` to a past date.
 *
 * `service` — optional filter to one service; omit to get everything.
 */
export class BookingsRequestDto {
  @IsOptional() @IsUUID() user_id?: string;
  @IsOptional() @IsEmail() @MaxLength(255) email?: string;
  @IsOptional() @IsString() @MaxLength(10) from?: string;
  @IsOptional() @IsString() @MaxLength(10) to?: string;
  @IsOptional() @IsIn(["cleaning", "food", "beach", "rental"]) service?: string;
}

export type IntegrationServiceKey = "cleaning" | "food" | "beach" | "rental";

export interface IntegrationBooking {
  /** Which service this row is from. */
  service: IntegrationServiceKey;
  /** Legacy id in the underlying source table — stable, opaque to Builders Node. */
  id: string;
  /** Human plan / package / court / vehicle name. Best-effort, may be null. */
  plan_name: string | null;
  /** Provider (restaurant / cleaning company / beach club / rental company) name. */
  provider_name: string | null;
  /**
   * ISO-8601 with -06:00 Honduras offset. For subscription-window rows
   * (food, rental period) start_at is the period start.
   */
  start_at: string;
  /** ISO-8601. Null when the source table doesn't carry an end (open-ended). */
  end_at: string | null;
  /** Raw service-specific status string (`booked` / `active` / `confirmed` / …). */
  status: string;
  /** Free-form context (address, notes, apartment note). */
  notes: string | null;
}

export interface BookingsResponse {
  user_id: string;
  /** Requested date window echoed back. */
  from: string;
  to: string;
  /** Bookings sorted by start_at ascending, across all services. */
  bookings: IntegrationBooking[];
}
