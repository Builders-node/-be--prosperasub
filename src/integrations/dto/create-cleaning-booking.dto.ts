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
   * Always true. A `start_time` that isn't on the published grid is now
   * rejected with 400 (the message lists that day's open times) instead of
   * quietly getting a slot of its own, so a booking can only exist on a real
   * published slot. Retained so existing partner code reading it keeps working.
   */
  slot_existed?: boolean;
  /**
   * Whether the visit reached the cleaners' Google Calendar during this call.
   * False doesn't mean the booking failed — it's committed either way, and the
   * calendar cron retries. It means nobody has been told to show up *yet*.
   */
  calendar_synced?: boolean;
  /** Why the calendar sync didn't happen. Present only when calendar_synced is false. */
  calendar_warning?: string;
  status: "booked";
}
