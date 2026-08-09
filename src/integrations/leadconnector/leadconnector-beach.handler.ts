import { Injectable, Logger, OnModuleInit } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { PrismaService } from "../../prisma/prisma.service";
import { EventSubscriberRegistry } from "../../events/event-subscriber-registry";
import { ResourceService } from "../../resource/resource.service";
import type { DomainEventEnvelope, DomainEventHandler } from "../../events/domain-event";
import { LeadconnectorService } from "./leadconnector.service";

/**
 * Mirrors confirmed beach-court bookings into Pristine Bay's LeadConnector
 * calendar. Subscribes to `booking.BookingConfirmed` (published by
 * `BookingService.confirm`) and runs the 3-step flow their ops team documented:
 *
 *   1. free-slot pre-check on the target calendar (cheap round-trip; abort
 *      early if their side already has the slot taken so we don't leave an
 *      orphaned contact behind)
 *   2. contact upsert by email/phone → we get back their `contactId`
 *   3. appointment create with `ignoreFreeSlotValidation:false` — belt-and-
 *      suspenders collision protection between Step 1 and Step 3
 *
 * Filters:
 *   - Only fires for beach resources (`source_service_key === 'beach'`)
 *   - Only fires when we can find a `calendarId` for the court via
 *     `LEADCONNECTOR_COURT_CALENDAR_MAP` (JSON `{"court-uuid": "calendar-id"}`)
 *
 * Failure policy: NEVER throws. A LeadConnector rejection doesn't roll back
 * our booking — that's the point of the mirror pattern. Every leg logs to
 * the console and — on the create-appointment step — writes the outcome into
 * `Booking.notes` as a JSON marker for admin diagnostics + future idempotency.
 *
 * Idempotency: the domain event dispatcher already dedupes per (event id,
 * consumer name), so the handler is called at-most-once per confirmation.
 * The notes marker adds a second line of defense against duplicate mirror
 * calls if the marker is ever added AFTER a successful appointment create.
 */

const CONSUMER_NAME = "leadconnector-beach-mirror";

interface BookingLike {
  id: string;
  resourceId: string;
  subjectRef: string | null;
  startAt: Date;
  endAt: Date;
  notes: string | null;
}

@Injectable()
export class LeadconnectorBeachHandler implements DomainEventHandler, OnModuleInit {
  readonly name = CONSUMER_NAME;
  private readonly logger = new Logger(LeadconnectorBeachHandler.name);

  constructor(
    private readonly registry: EventSubscriberRegistry,
    private readonly prisma: PrismaService,
    private readonly resources: ResourceService,
    private readonly leadconnector: LeadconnectorService,
    private readonly config: ConfigService,
  ) {}

  onModuleInit(): void {
    this.registry.register(this);
  }

  handles(type: string): boolean {
    return type === "booking.BookingConfirmed";
  }

  async handle(event: DomainEventEnvelope): Promise<void> {
    if (!this.leadconnector.isConfigured()) return; // silently skip in dev/test
    if (!this.prisma.isAvailable()) return;

    const payload = event.payload as { bookingId?: string; resourceId?: string | null } | null;
    const bookingId = payload?.bookingId;
    if (!bookingId) return;

    const booking = (await this.prisma.booking.findUnique({
      where: { id: bookingId },
      select: {
        id: true, resourceId: true, subjectRef: true,
        startAt: true, endAt: true, notes: true,
      },
    })) as BookingLike | null;
    if (!booking) return;

    // Bail if we already mirrored this booking (marker in notes).
    if (this.notesHasMirrorMarker(booking.notes)) return;

    const resource = await this.resources.getResource(booking.resourceId);
    if (resource?.source_service_key !== "beach" || !resource.source_resource_id) return;

    const calendarId = this.calendarIdFor(resource.source_resource_id, booking.resourceId);
    if (!calendarId) {
      // Both ids in the message: whichever one the operator used, this line
      // tells them the key that would have matched.
      this.logger.warn(
        `[leadconnector] no calendarId for court "${resource.name ?? resource.source_resource_id}" — skip. ` +
        `Add either id to LEADCONNECTOR_COURT_CALENDAR_MAP: ` +
        `source_resource_id=${resource.source_resource_id} resource_id=${booking.resourceId}`,
      );
      return;
    }

    const customer = await this.resolveCustomer(booking.subjectRef);
    if (!customer.email && !customer.phone) {
      // The LC API upserts by email/phone. With neither, contact creation is
      // pointless — we'd end up with a duplicate anonymous row on every call.
      this.logger.warn(`[leadconnector] booking ${booking.id} has no email/phone — skip`);
      return;
    }

    const startISO = this.toIsoWithOffset(booking.startAt);
    const endISO = this.toIsoWithOffset(booking.endAt);
    const startMs = booking.startAt.getTime();
    const endMs = booking.endAt.getTime();

    // Step 1 — free-slot pre-check. Not a hard gate (Step 3 is
    // authoritative with ignoreFreeSlotValidation=false), but it lets us
    // skip Step 2's contact upsert when the slot's obviously gone.
    const slots = await this.leadconnector.getFreeSlots(calendarId, startMs, endMs);
    if (!slots.ok) {
      this.logger.warn(
        `[leadconnector] booking ${booking.id} step 1 failed (${slots.status}): ${slots.error} — proceeding anyway`,
      );
    }

    // Step 2 — upsert contact
    const contact = await this.leadconnector.upsertContact({
      firstName: customer.firstName,
      lastName: customer.lastName,
      email: customer.email,
      phone: customer.phone,
    });
    if (!contact.ok) {
      await this.writeMarker(booking, {
        status: "failed_upsert_contact", error: contact.error, at: new Date().toISOString(),
      });
      this.logger.warn(`[leadconnector] booking ${booking.id} step 2 failed: ${contact.error}`);
      return;
    }
    const contactId =
      contact.data?.contact?.id || contact.data?.contactId;
    if (!contactId) {
      await this.writeMarker(booking, {
        status: "failed_no_contact_id", raw: contact.data, at: new Date().toISOString(),
      });
      this.logger.warn(`[leadconnector] booking ${booking.id} contact upsert returned no id`);
      return;
    }

    // Step 3 — create appointment
    const title = `Court Booking · ${resource.name || "Beach Club"}`;
    const appt = await this.leadconnector.createAppointment({
      title,
      calendarId,
      contactId,
      startTime: startISO,
      endTime: endISO,
      ignoreFreeSlotValidation: false,
    });
    if (!appt.ok) {
      await this.writeMarker(booking, {
        status: "failed_create_appointment", error: appt.error,
        calendar_id: calendarId, contact_id: contactId, at: new Date().toISOString(),
      });
      this.logger.warn(`[leadconnector] booking ${booking.id} step 3 failed: ${appt.error}`);
      return;
    }
    const appointmentId = appt.data?.id || appt.data?.appointmentId || null;
    await this.writeMarker(booking, {
      status: "confirmed",
      calendar_id: calendarId,
      contact_id: contactId,
      appointment_id: appointmentId,
      at: new Date().toISOString(),
    });
    this.logger.log(
      `[leadconnector] booking ${booking.id} mirrored → appointment ${appointmentId ?? "(no id)"}`,
    );
  }

  // ─── Helpers ───────────────────────────────────────────────────────────

  /**
   * Look the calendar up by EITHER of the court's two ids.
   *
   * A court has a legacy `beach_club_courts.id` and an engine
   * `bookable_resources.id`, and they are different UUIDs. This only accepted
   * the legacy one — but the engine id is what the admin UI and `GET /resources`
   * put on screen, so a map filled from what's visible matched nothing. The
   * handler never throws by design, so the mirror just silently did nothing.
   *
   * Neither id is more "correct" than the other to someone writing config, so
   * accept both rather than making that a thing you have to know.
   */
  private calendarIdFor(courtSourceId: string, engineResourceId?: string): string | null {
    const raw = this.config.get<string>("LEADCONNECTOR_COURT_CALENDAR_MAP");
    if (!raw) return null;
    let map: Record<string, string> | null = null;
    try {
      map = JSON.parse(raw);
    } catch {
      this.logger.warn("[leadconnector] LEADCONNECTOR_COURT_CALENDAR_MAP is not valid JSON");
      return null;
    }
    if (!map || typeof map !== "object") return null;
    return map[courtSourceId] || (engineResourceId ? map[engineResourceId] : null) || null;
  }

  private async resolveCustomer(subjectRef: string | null): Promise<{
    firstName: string; lastName: string; email: string | null; phone: string | null;
  }> {
    const empty = { firstName: "", lastName: "", email: null, phone: null };
    if (!subjectRef?.startsWith("user:")) return empty;
    const userId = subjectRef.slice("user:".length);
    if (!userId) return empty;

    const base = process.env.SUPABASE_URL?.replace(/\/$/, "");
    const key = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_ANON_KEY;
    if (!base || !key) return empty;
    try {
      const res = await fetch(
        `${base}/rest/v1/users?select=email,name,display_name,phone&id=eq.${encodeURIComponent(userId)}&limit=1`,
        { headers: { apikey: key, Authorization: `Bearer ${key}` } },
      );
      if (!res.ok) return empty;
      const rows = (await res.json().catch(() => [])) as Array<{
        email?: string | null; name?: string | null; display_name?: string | null; phone?: string | null;
      }>;
      const row = rows[0];
      if (!row) return empty;
      const fullName = (row.display_name || row.name || "").trim();
      const parts = fullName.split(/\s+/);
      return {
        firstName: parts[0] || "",
        lastName:  parts.slice(1).join(" ") || "",
        email: row.email ?? null,
        phone: row.phone ?? null,
      };
    } catch {
      return empty;
    }
  }

  /**
   * Format a Date as YYYY-MM-DDTHH:MM:SS with Honduras' -06:00 offset.
   * LeadConnector requires an offset (no bare UTC) — Pristine Bay is on
   * America/Tegucigalpa, no DST, so -06:00 is always correct.
   */
  private toIsoWithOffset(d: Date): string {
    const offsetMinutes = -6 * 60; // Honduras
    const shifted = new Date(d.getTime() + offsetMinutes * 60_000);
    const yyyy = shifted.getUTCFullYear();
    const mm = String(shifted.getUTCMonth() + 1).padStart(2, "0");
    const dd = String(shifted.getUTCDate()).padStart(2, "0");
    const HH = String(shifted.getUTCHours()).padStart(2, "0");
    const MM = String(shifted.getUTCMinutes()).padStart(2, "0");
    const SS = String(shifted.getUTCSeconds()).padStart(2, "0");
    return `${yyyy}-${mm}-${dd}T${HH}:${MM}:${SS}-06:00`;
  }

  // ─── Notes marker (JSON in Booking.notes, wrapped so admin notes survive) ─

  private static readonly MARKER_PREFIX = "\n\n[leadconnector]";

  private notesHasMirrorMarker(notes: string | null): boolean {
    if (!notes) return false;
    return notes.includes(LeadconnectorBeachHandler.MARKER_PREFIX);
  }

  private async writeMarker(booking: BookingLike, marker: Record<string, unknown>): Promise<void> {
    const base = booking.notes ?? "";
    const stamp = `${LeadconnectorBeachHandler.MARKER_PREFIX} ${JSON.stringify(marker)}`;
    try {
      await this.prisma.booking.update({
        where: { id: booking.id },
        data: { notes: base + stamp },
      });
    } catch (err) {
      this.logger.warn(`[leadconnector] could not stamp mirror marker on ${booking.id}: ${(err as Error).message}`);
    }
  }
}
