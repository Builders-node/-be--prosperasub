/**
 * Booking domain — the Schedule (availability configuration) and its slot math.
 * This is the backend port of the frontend `bookingSettings`/`computeSlots` so
 * the SAME rules drive availability everywhere. Industry-agnostic: the engine
 * dispatches on a resource's booking_model, never on an industry.
 */

export interface DayHours {
  enabled: boolean;
  from: string; // "HH:MM"
  to: string;   // "HH:MM"
}

export interface BlockedRange {
  /** "YYYY-MM-DD" for a one-off, or **null for every day** (a lunch hour, a
   *  shift changeover). Must stay in step with the frontend's BlockedRange. */
  date: string | null;
  from: string;   // "HH:MM"
  to: string;     // "HH:MM"
}

/** Does this block apply on the given day? */
export function blockAppliesOn(range: BlockedRange, dateISO: string): boolean {
  return range.date === null || range.date === dateISO;
}

/**
 * If [start, end) runs into any of these blocks, the END of the latest one it
 * runs into — the minute the day is free again. Null when nothing is hit.
 *
 * The generator resumes exactly here, so a slot follows a blocked period
 * immediately rather than a buffer's width later. Must stay in step with the
 * frontend's `latestBlockEnd`. Times are minutes since midnight.
 */
export function latestBlockEnd(ranges: BlockedRange[], start: number, end: number): number | null {
  let latest: number | null = null;
  for (const r of ranges) {
    const from = toMinutes(r.from);
    const to = toMinutes(r.to);
    if (Number.isNaN(from) || Number.isNaN(to)) continue;
    if (start < to && end > from && (latest === null || to > latest)) latest = to;
  }
  return latest;
}

export interface Schedule {
  timezone: string;
  /** Length 7, Monday-first (index 0 = Monday). */
  weekly: DayHours[];
  sessionDurationMin: number;
  bufferBeforeMin: number;
  bufferAfterMin: number;
  minNoticeHours: number;
  maxAdvanceDays: number;
  blockedDates: string[];
  blockedRanges: BlockedRange[];
  /**
   * Who may book, and how much of it.
   *
   * The schedule above says WHEN a slot exists. This says who is allowed to
   * take one and how many they may hold — the questions that decide whether a
   * booking page is usable by a business rather than only by a demo. Every
   * value is the provider's to set; nothing here is hard-coded policy.
   */
  policy: BookingPolicy;
}

export interface BookingPolicy {
  /**
   * Only customers with an active subscription to this provider may book.
   * The beach club's courts are included with membership, so the answer there
   * is yes; a court sold by the hour to anybody would say no.
   */
  requiresMembership: boolean;
  /** Upcoming bookings one customer may hold at once. 0 = no limit. */
  maxActiveBookings: number;
  /** Slots one customer may take on a single day. 0 = no limit. */
  maxPerDay: number;
  /**
   * How close to the start a customer may still cancel, in hours. Past that
   * the slot is theirs — cancelling at the last minute leaves a court empty
   * that somebody else would have taken.
   */
  cancelNoticeHours: number;
}

export const DEFAULT_POLICY: BookingPolicy = {
  // Off by default: turning a restriction on is a decision, and inheriting one
  // nobody chose would lock customers out of every provider that never opened
  // this screen.
  requiresMembership: false,
  maxActiveBookings: 0,
  maxPerDay: 0,
  cancelNoticeHours: 0,
};

export const DEFAULT_SCHEDULE: Schedule = {
  timezone: "America/Tegucigalpa",
  weekly: [
    { enabled: true, from: "09:00", to: "17:00" },
    { enabled: true, from: "09:00", to: "17:00" },
    { enabled: true, from: "09:00", to: "17:00" },
    { enabled: true, from: "09:00", to: "17:00" },
    { enabled: true, from: "09:00", to: "17:00" },
    { enabled: false, from: "09:00", to: "13:00" },
    { enabled: false, from: "09:00", to: "13:00" },
  ],
  sessionDurationMin: 60,
  bufferBeforeMin: 0,
  bufferAfterMin: 0,
  minNoticeHours: 12,
  maxAdvanceDays: 30,
  blockedDates: [],
  blockedRanges: [],
  policy: DEFAULT_POLICY,
};

export function toMinutes(hhmm: string): number {
  const [h, m] = (hhmm ?? "").split(":").map(Number);
  if (Number.isNaN(h) || Number.isNaN(m)) return Number.NaN;
  return h * 60 + m;
}

export function toHHMM(mins: number): string {
  const m = ((mins % 1440) + 1440) % 1440;
  return `${String(Math.floor(m / 60)).padStart(2, "0")}:${String(m % 60).padStart(2, "0")}`;
}

/** JS Date.getDay() (0=Sun) → Monday-first index (0=Mon). */
export function mondayFirstIndex(jsDay: number): number {
  return (jsDay + 6) % 7;
}

/** Backfill any missing/partial fields so old or absent config stays usable. */
/** Absent or malformed means "no restriction", never "locked". */
export function normalizePolicy(raw: unknown): BookingPolicy {
  const p = (raw ?? {}) as Partial<BookingPolicy>;
  const count = (v: unknown) => (Number(v) > 0 ? Math.floor(Number(v)) : 0);
  return {
    requiresMembership: p.requiresMembership === true,
    maxActiveBookings: count(p.maxActiveBookings),
    maxPerDay: count(p.maxPerDay),
    cancelNoticeHours: Math.max(0, Number(p.cancelNoticeHours) || 0),
  };
}

export function normalizeSchedule(raw: unknown): Schedule {
  const d = DEFAULT_SCHEDULE;
  const s = (raw ?? {}) as Partial<Schedule>;
  const weekly = Array.isArray(s.weekly) && s.weekly.length === 7
    ? s.weekly.map((w, i) => ({
        enabled: Boolean(w?.enabled),
        from: w?.from || d.weekly[i].from,
        to: w?.to || d.weekly[i].to,
      }))
    : d.weekly.map((w) => ({ ...w }));
  return {
    timezone: s.timezone || d.timezone,
    weekly,
    sessionDurationMin: Number(s.sessionDurationMin) > 0 ? Number(s.sessionDurationMin) : d.sessionDurationMin,
    bufferBeforeMin: Math.max(0, Number(s.bufferBeforeMin) || 0),
    bufferAfterMin: Math.max(0, Number(s.bufferAfterMin) || 0),
    minNoticeHours: Math.max(0, Number(s.minNoticeHours) || 0),
    maxAdvanceDays: Number(s.maxAdvanceDays) > 0 ? Number(s.maxAdvanceDays) : d.maxAdvanceDays,
    blockedDates: Array.isArray(s.blockedDates) ? s.blockedDates.filter((x): x is string => typeof x === "string") : [],
    // The date is optional and its absence is meaningful: no date = every day.
    // "" was what the old editor wrote when no date was picked, and it matched
    // nothing — it now reads as what the provider meant.
    blockedRanges: Array.isArray(s.blockedRanges)
      ? s.blockedRanges
          .filter((r): r is BlockedRange => !!r && typeof r.from === "string" && typeof r.to === "string")
          .map((r) => ({ ...r, date: typeof r.date === "string" && r.date !== "" ? r.date : null }))
      : [],
    policy: normalizePolicy(s.policy),
  };
}
