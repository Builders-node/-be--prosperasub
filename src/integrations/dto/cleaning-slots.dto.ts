import { IsBoolean, IsOptional, IsString, Matches } from "class-validator";

/**
 * Request body for `POST /integrations/builders-node/cleaning-slots`.
 *
 * The other half of the cleaning flow. `POST /cleaning-booking` requires an
 * exact `date` + `start_time`, and nothing told the partner which times exist —
 * so their UI had to guess, and a guessed 09:37 quietly succeeded, producing a
 * visit outside the real schedule. Booking now rejects any start_time not
 * listed here, which makes calling this endpoint first mandatory rather than
 * merely advisable.
 *
 * `from` / `to` — YYYY-MM-DD, Honduras local. Defaults to today → +30 days.
 */
export class CleaningSlotsRequestDto {
  @IsOptional()
  @IsString()
  @Matches(/^\d{4}-\d{2}-\d{2}$/, { message: "from must be YYYY-MM-DD" })
  from?: string;

  @IsOptional()
  @IsString()
  @Matches(/^\d{4}-\d{2}-\d{2}$/, { message: "to must be YYYY-MM-DD" })
  to?: string;

  /**
   * Default true — return only slots a customer could actually take. Set false
   * to see the full grid including full and disabled ones, e.g. to grey them
   * out in a picker rather than hiding them.
   */
  @IsOptional()
  @IsBoolean()
  only_available?: boolean;
}

export interface CleaningSlot {
  /** Opaque slot id — pass nothing back; book by date + start_time. */
  id: string;
  /** YYYY-MM-DD, Honduras local. */
  date: string;
  /** HH:MM, 24h, Honduras local — exactly what `cleaning-booking` expects. */
  start_time: string;
  /** HH:MM, 24h, Honduras local. */
  end_time: string;
  /** ISO-8601 with the -06:00 Honduras offset, for calendars. */
  start_at: string;
  end_at: string;
  capacity: number;
  booked: number;
  /** capacity − booked, floored at 0. */
  remaining: number;
  /** False when the slot is full or switched off. */
  available: boolean;
}

export interface CleaningSlotsResponse {
  from: string;
  to: string;
  /** Ascending by date then start_time. */
  slots: CleaningSlot[];
}
