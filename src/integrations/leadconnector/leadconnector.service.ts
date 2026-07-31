import { Injectable, Logger } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";

/**
 * Thin HTTP client for LeadConnector (GoHighLevel) — Pristine Bay's calendar system.
 *
 * Exposes the three calls Pristine's ops team documented for us:
 *   1. `getFreeSlots`     — GET /calendars/{id}/free-slots?startDate&endDate
 *   2. `upsertContact`    — POST /contacts/upsert
 *   3. `createAppointment`— POST /calendars/events/appointments
 *
 * Everything here is pure I/O — no business rules. The event handler that
 * mirrors beach-court bookings composes these three calls in order.
 *
 * Configuration:
 *   LEADCONNECTOR_API_KEY       — bearer token (their "pit-..." personal token)
 *   LEADCONNECTOR_LOCATION_ID   — Pristine Bay's locationId, mandatory on
 *                                 upsertContact + createAppointment
 *   LEADCONNECTOR_BASE_URL      — defaults to https://services.leadconnectorhq.com
 *                                 (override for staging / self-hosted mocks)
 *
 * We do NOT throw on transport failures — the caller decides whether a mirror
 * failure should block the user (never) or just get logged (always).
 */

const DEFAULT_BASE_URL = "https://services.leadconnectorhq.com";
const API_VERSION = "v3";

export interface FreeSlotResponse {
  /** Their API groups slots by date: { "2026-07-30": ["slot1ISO", ...] } */
  [dateISO: string]: unknown;
}

export interface UpsertContactInput {
  firstName?: string;
  lastName?: string;
  email?: string | null;
  phone?: string | null;
}

export interface UpsertContactResponse {
  contact?: { id?: string };
  contactId?: string; // fallback shape seen in some responses
  new?: boolean;
}

export interface CreateAppointmentInput {
  title: string;
  calendarId: string;
  contactId: string;
  /** ISO 8601 with timezone offset, e.g. "2026-07-30T11:00:00-06:00" */
  startTime: string;
  endTime: string;
  appointmentStatus?: "confirmed" | "cancelled" | "showed" | "noshow" | "new";
  /** Keep false — server-side collision detection. Only override in admin recovery flows. */
  ignoreFreeSlotValidation?: boolean;
  address?: string | null;
  meetingLocationType?: string;
}

export interface CreateAppointmentResponse {
  id?: string;
  appointmentId?: string; // some responses use this
  calendarId?: string;
  contactId?: string;
  startTime?: string;
  endTime?: string;
}

export type LeadconnectorResult<T> =
  | { ok: true; data: T; status: number }
  | { ok: false; error: string; status: number };

@Injectable()
export class LeadconnectorService {
  private readonly logger = new Logger(LeadconnectorService.name);

  constructor(private readonly config: ConfigService) {}

  isConfigured(): boolean {
    return !!this.config.get<string>("LEADCONNECTOR_API_KEY")?.trim();
  }

  /** Step 1 — list every free slot in the window. Their API caps range at 31 days. */
  async getFreeSlots(
    calendarId: string,
    startEpochMs: number,
    endEpochMs: number,
  ): Promise<LeadconnectorResult<FreeSlotResponse>> {
    const url = `/calendars/${encodeURIComponent(calendarId)}/free-slots?startDate=${startEpochMs}&endDate=${endEpochMs}`;
    return this.request<FreeSlotResponse>("GET", url);
  }

  /** Step 2 — upsert by email/phone. Returns their internal `contactId`. */
  async upsertContact(input: UpsertContactInput): Promise<LeadconnectorResult<UpsertContactResponse>> {
    const locationId = this.locationId();
    if (!locationId) return { ok: false, error: "LEADCONNECTOR_LOCATION_ID not set", status: 0 };
    const body = {
      firstName: input.firstName || "",
      lastName: input.lastName || "",
      email: input.email || undefined,
      phone: input.phone || undefined,
      locationId,
    };
    return this.request<UpsertContactResponse>("POST", "/contacts/upsert", body);
  }

  /** Step 3 — book the appointment. `ignoreFreeSlotValidation` defaults false (their rec). */
  async createAppointment(input: CreateAppointmentInput): Promise<LeadconnectorResult<CreateAppointmentResponse>> {
    const locationId = this.locationId();
    if (!locationId) return { ok: false, error: "LEADCONNECTOR_LOCATION_ID not set", status: 0 };
    const body = {
      title: input.title,
      calendarId: input.calendarId,
      locationId,
      contactId: input.contactId,
      startTime: input.startTime,
      endTime: input.endTime,
      appointmentStatus: input.appointmentStatus ?? "confirmed",
      ignoreFreeSlotValidation: input.ignoreFreeSlotValidation ?? false,
      address: input.address ?? undefined,
      meetingLocationType: input.meetingLocationType ?? undefined,
    };
    return this.request<CreateAppointmentResponse>("POST", "/calendars/events/appointments", body);
  }

  // ─── Internals ───────────────────────────────────────────────────────────

  private locationId(): string | null {
    return this.config.get<string>("LEADCONNECTOR_LOCATION_ID")?.trim() || null;
  }

  private baseUrl(): string {
    return (this.config.get<string>("LEADCONNECTOR_BASE_URL") || DEFAULT_BASE_URL).replace(/\/$/, "");
  }

  private async request<T>(
    method: "GET" | "POST",
    path: string,
    body?: unknown,
  ): Promise<LeadconnectorResult<T>> {
    const apiKey = this.config.get<string>("LEADCONNECTOR_API_KEY")?.trim();
    if (!apiKey) {
      return { ok: false, error: "LEADCONNECTOR_API_KEY not set", status: 0 };
    }

    const url = `${this.baseUrl()}${path.startsWith("/") ? path : "/" + path}`;
    try {
      const res = await fetch(url, {
        method,
        headers: {
          Authorization: `Bearer ${apiKey}`,
          Version: API_VERSION,
          Accept: "application/json",
          ...(body ? { "Content-Type": "application/json" } : {}),
        },
        body: body ? JSON.stringify(body) : undefined,
      });
      const text = await res.text().catch(() => "");
      const parsed: unknown = text ? safeJson(text) : null;
      if (!res.ok) {
        // Trim the message so we don't dump a 20KB error into the log.
        const msg = typeof parsed === "object" && parsed !== null && "message" in parsed
          ? String((parsed as { message: unknown }).message)
          : text.slice(0, 500) || res.statusText;
        this.logger.warn(`[leadconnector] ${method} ${path} → ${res.status}: ${msg}`);
        return { ok: false, error: `${res.status}: ${msg}`, status: res.status };
      }
      return { ok: true, data: (parsed ?? {}) as T, status: res.status };
    } catch (err) {
      const msg = (err as Error).message || "network error";
      this.logger.error(`[leadconnector] ${method} ${path} network error: ${msg}`);
      return { ok: false, error: msg, status: 0 };
    }
  }
}

function safeJson(text: string): unknown {
  try { return JSON.parse(text); } catch { return null; }
}
