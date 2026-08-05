import { IsBoolean, IsOptional, IsString, Matches } from "class-validator";

/**
 * Request body for `POST /integrations/builders-node/cleaning-slots`.
 *
 * The missing half of the cleaning flow. `POST /cleaning-booking` has always
 * required an exact `date` + `start_time`, but nothing told the partner which
 * times exist — so their UI had to guess, and because the booking endpoint
 * creates a slot on demand when nothing matches, a guessed 09:37 quietly
 * succeeded and produced a visit outside the real schedule.
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
