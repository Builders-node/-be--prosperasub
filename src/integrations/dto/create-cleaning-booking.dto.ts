import { IsEmail, IsOptional, IsString, IsUUID, Matches, MaxLength } from "class-validator";

/**
 * Request body for `POST /integrations/builders-node/cleaning-booking`.
 *
 * Books a single cleaning visit under the user's existing paid cleaning
 * subscription. Builders Node's UI collects date + time from their customer
 * and calls this endpoint after payment already succeeded on our side (the
 * partner has previously provisioned the subscription via `/subscription`).
 *
 * Identify the user by `user_id` (preferred) or `email`. If the user has
 * more than one paid+active cleaning subscription, `subscription_id`
 * must be explicit — otherwise we take the first one.
 *
 * `date` = YYYY-MM-DD (Honduras local). `start_time` = HH:MM (24h).
 * `end_time` optional; defaults to +2 hours (or start when omitted equals
 * a zero-duration marker slot).
 */
export class CreateCleaningBookingDto {
  @IsOptional() @IsUUID() user_id?: string;
  @IsOptional() @IsEmail() @MaxLength(255) email?: string;

  @IsString()
  @Matches(/^\d{4}-\d{2}-\d{2}$/, { message: "date must be YYYY-MM-DD" })
  date!: string;

  @IsString()
  @Matches(/^\d{2}:\d{2}$/, { message: "start_time must be HH:MM (24h)" })
  start_time!: string;

  @IsOptional() @IsString() @Matches(/^\d{2}:\d{2}$/, { message: "end_time must be HH:MM (24h)" })
  end_time?: string;

  @IsOptional() @IsUUID() subscription_id?: string;
  @IsOptional() @IsString() @MaxLength(2000) notes?: string;
}

export interface CreateCleaningBookingResponse {
  booking_id: string;
  subscription_id: string;
  slot_id: string;
  date: string;
  start_time: string;
  end_time: string;
  /**
   * True when the time matched a slot already on the schedule. False means one
   * was created for it — i.e. the visit sits outside the published grid. Call
   * `/cleaning-slots` and book a listed start_time to keep this true.
   */
  slot_existed?: boolean;
  /** Present only when slot_existed is false. */
  warning?: string;
  status: "booked";
}
