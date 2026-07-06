import { mondayFirstIndex, toHHMM, toMinutes, type Schedule } from "./schedule";
import type { BookingModel } from "../resource/resource-type";

export interface Slot {
  from: string;
  to: string;
  capacity?: number;
}

/** Weekly hours for a given date, or null if the day is closed/blocked. */
function openWindow(schedule: Schedule, dateISO: string): { open: number; close: number } | null {
  if (!dateISO || schedule.blockedDates.includes(dateISO)) return null;
  const [y, m, d] = dateISO.split("-").map(Number);
  const jsDay = new Date(y, (m ?? 1) - 1, d ?? 1).getDay();
  const day = schedule.weekly[mondayFirstIndex(jsDay)];
  if (!day?.enabled) return null;
  const open = toMinutes(day.from);
  const close = toMinutes(day.to);
  if (Number.isNaN(open) || Number.isNaN(close) || close <= open) return null;
  return { open, close };
}

/**
 * time_slot strategy — the ported `computeSlots`: fixed-length sessions across
 * the day's window, each occupying buffer_before + duration + buffer_after,
 * skipping any that overlap a blocked range.
 */
function timeSlotStrategy(schedule: Schedule, dateISO: string, capacity?: number): Slot[] {
  const win = openWindow(schedule, dateISO);
  if (!win) return [];
  const dur = schedule.sessionDurationMin;
  if (dur <= 0) return [];
  const step = schedule.bufferBeforeMin + dur + schedule.bufferAfterMin;
  const ranges = schedule.blockedRanges.filter((r) => r.date === dateISO);
  const slots: Slot[] = [];
  for (let start = win.open; start + dur <= win.close; start += step) {
    const end = start + dur;
    const blocked = ranges.some((r) => {
      const bf = toMinutes(r.from);
      const bt = toMinutes(r.to);
      return !Number.isNaN(bf) && !Number.isNaN(bt) && start < bt && end > bf;
    });
    if (!blocked) slots.push({ from: toHHMM(start), to: toHHMM(end), capacity: capacity ?? 1 });
  }
  return slots;
}

/**
 * date_range strategy — a whole-day availability check. If the day is open (and
 * not blocked) the resource is bookable for date ranges starting that day; we
 * return one window spanning the day.
 */
function dateRangeStrategy(schedule: Schedule, dateISO: string, capacity?: number): Slot[] {
  const win = openWindow(schedule, dateISO);
  if (!win) return [];
  return [{ from: toHHMM(win.open), to: toHHMM(win.close), capacity: capacity ?? 1 }];
}

/**
 * The engine seam: pick a strategy by the resource's booking_model. Adding a new
 * industry never touches this — a new resource_type just declares one of the
 * existing models.
 */
export function generateSlots(model: BookingModel, schedule: Schedule, dateISO: string, capacity?: number): Slot[] {
  switch (model) {
    case "date_range":
      return dateRangeStrategy(schedule, dateISO, capacity);
    case "capacity_seat":
      // Same time windows as time_slot, but each window carries the resource's seat capacity.
      return timeSlotStrategy(schedule, dateISO, capacity ?? 1);
    case "time_slot":
    default:
      return timeSlotStrategy(schedule, dateISO, capacity);
  }
}
