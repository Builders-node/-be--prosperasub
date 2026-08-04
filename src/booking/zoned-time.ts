/**
 * Wall-clock ↔ instant conversion for the booking engine.
 *
 * Every time the engine handles is a WALL CLOCK time in the resource's own
 * timezone: a provider's schedule says "open 06:00–19:00" meaning 06:00 where
 * the court physically is, and a customer taps "18:00" meaning 18:00 there.
 *
 * `new Date("2026-08-04T18:00:00")` — no offset, no Z — is parsed in the
 * *process's* local timezone. On Vercel that is UTC, so an 18:00 Honduras slot
 * was stored as 18:00Z, i.e. 12:00 Honduras: every booking landed six hours
 * away from the time the customer picked. The stored `slot_key` said 18:00 and
 * `start_at` said 18:00+00, so the row disagreed with itself.
 *
 * These helpers make the zone explicit at every boundary.
 */

/**
 * Offset of `timeZone` from UTC at instant `at`, in milliseconds.
 * Positive east of Greenwich (Honduras returns -6h).
 */
function zoneOffsetMs(at: Date, timeZone: string): number {
  const dtf = new Intl.DateTimeFormat("en-US", {
    timeZone,
    hour12: false,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
  const parts: Record<string, string> = {};
  for (const p of dtf.formatToParts(at)) parts[p.type] = p.value;
  const asUtc = Date.UTC(
    Number(parts.year),
    Number(parts.month) - 1,
    Number(parts.day),
    // Intl renders midnight as "24" in some ICU versions.
    Number(parts.hour) % 24,
    Number(parts.minute),
    Number(parts.second),
  );
  return asUtc - at.getTime();
}

/**
 * The instant at which the wall clock in `timeZone` reads `dateISO` `timeHHmm`.
 *
 *   zonedWallClockToInstant("2026-08-04", "18:00", "America/Tegucigalpa")
 *     → 2026-08-05T00:00:00.000Z   (18:00 HN = 00:00 UTC next day)
 *
 * Resolved in two passes: the first guess uses the offset at the naive instant,
 * the second re-reads the offset at that guess. That second pass only matters
 * for zones with DST, where the first guess can land on the wrong side of a
 * transition. Honduras has no DST, so it converges immediately.
 */
export function zonedWallClockToInstant(dateISO: string, timeHHmm: string, timeZone: string): Date {
  const naive = new Date(`${dateISO}T${normalizeTime(timeHHmm)}Z`);
  if (Number.isNaN(naive.getTime())) return naive;
  const firstGuess = new Date(naive.getTime() - zoneOffsetMs(naive, timeZone));
  return new Date(naive.getTime() - zoneOffsetMs(firstGuess, timeZone));
}

/**
 * Half-open [start, end) instants covering the calendar day `dateISO` as lived
 * in `timeZone`. Used to list a day's bookings — a plain UTC midnight window
 * clips the local evening and pulls in the previous local evening.
 */
export function zonedDayRange(dateISO: string, timeZone: string): { start: Date; end: Date } {
  const start = zonedWallClockToInstant(dateISO, "00:00", timeZone);
  const nextDay = new Date(`${dateISO}T00:00:00Z`);
  nextDay.setUTCDate(nextDay.getUTCDate() + 1);
  const end = zonedWallClockToInstant(nextDay.toISOString().slice(0, 10), "00:00", timeZone);
  return { start, end };
}

/** "18:00" / "18:00:00" / "8:00" → "18:00:00". */
function normalizeTime(timeHHmm: string): string {
  const [h = "0", m = "0", s = "0"] = String(timeHHmm).split(":");
  return `${h.padStart(2, "0")}:${m.padStart(2, "0")}:${s.padStart(2, "0")}`;
}
