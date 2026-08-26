import { CourtBookingEmailHandler } from "./court-booking-email.handler";
import { EventSubscriberRegistry } from "../events/event-subscriber-registry";
import type { MailService } from "../mail/mail.service";

/**
 * Routes each rest() GET to canned data by table, so we exercise the whole
 * lookup chain (booking → resource → provider → user → membership) without a DB.
 */
function mockFetch(rows: Record<string, unknown[]>) {
  return jest.fn(async (url: string) => {
    const table = String(url).split("/rest/v1/")[1]?.split("?")[0] ?? "";
    return {
      ok: true,
      json: async () => rows[table] ?? [],
      text: async () => "",
    } as unknown as Response;
  });
}

const EVENT = {
  id: "evt-1",
  type: "booking.BookingConfirmed",
  subjectRef: "user:11111111-1111-1111-1111-111111111111",
  payload: { bookingId: "bk-1" },
} as any;

describe("CourtBookingEmailHandler", () => {
  const OLD_ENV = process.env;
  let mail: { sendMail: jest.Mock };
  let handler: CourtBookingEmailHandler;

  beforeEach(() => {
    process.env = { ...OLD_ENV, SUPABASE_URL: "https://x.supabase.co", SUPABASE_SERVICE_ROLE_KEY: "svc" };
    mail = { sendMail: jest.fn().mockResolvedValue(undefined) };
    handler = new CourtBookingEmailHandler(new EventSubscriberRegistry(), mail as unknown as MailService);
  });
  afterEach(() => { process.env = OLD_ENV; jest.restoreAllMocks(); });

  it("only handles booking.BookingConfirmed", () => {
    expect(handler.handles("booking.BookingConfirmed")).toBe(true);
    expect(handler.handles("booking.BookingCancelled")).toBe(false);
  });

  it("emails the team with date, time, court, name and phone", async () => {
    global.fetch = mockFetch({
      bookings: [{
        resource_id: "court-1", subject_ref: EVENT.subjectRef,
        start_at: "2026-08-18T18:00:00-06:00", end_at: "2026-08-18T19:00:00-06:00",
        label: null, provider_id: "prov-1", status: "confirmed",
      }],
      bookable_resources: [{ name: "Tennis Court 1", provider_id: "prov-1" }],
      providers: [{ name: "Beach Club", contact_email: "team@club.com" }],
      users: [{ name: "Maria Gonzalez", display_name: "Maria Gonzalez", email: "m@x.com" }],
      provider_subscriptions: [{ customer_whatsapp: "+50412345678" }],
    }) as any;

    await handler.handle(EVENT);

    expect(mail.sendMail).toHaveBeenCalledTimes(1);
    const msg = mail.sendMail.mock.calls[0][0];
    expect(msg.to).toBe("team@club.com");
    expect(msg.text).toContain("Tennis Court 1");
    expect(msg.text).toContain("Maria Gonzalez");
    expect(msg.text).toContain("+50412345678");
    expect(msg.text).toContain("Aug 18");
    expect(msg.text).toMatch(/6:00\s?PM.*7:00\s?PM/);
  });

  it("skips quietly when the provider has no contact_email (no send, no throw)", async () => {
    global.fetch = mockFetch({
      bookings: [{
        resource_id: "court-1", subject_ref: "desk:staff-1",
        start_at: "2026-08-18T18:00:00-06:00", end_at: "2026-08-18T19:00:00-06:00",
        label: "Walk-in Bob", provider_id: "prov-1", status: "confirmed",
      }],
      bookable_resources: [{ name: "Court 2", provider_id: "prov-1" }],
      providers: [{ name: "Beach Club", contact_email: null }],
    }) as any;

    await expect(handler.handle(EVENT)).resolves.toBeUndefined();
    expect(mail.sendMail).not.toHaveBeenCalled();
  });

  it("falls back to the owner + members when no contact_email is set", async () => {
    global.fetch = mockFetch({
      bookings: [{
        resource_id: "court-1", subject_ref: "desk:staff-1",
        start_at: "2026-08-18T18:00:00-06:00", end_at: "2026-08-18T19:00:00-06:00",
        label: "Walk-in Bob", provider_id: "prov-1", status: "confirmed",
      }],
      bookable_resources: [{ name: "Court 2", provider_id: "prov-1" }],
      providers: [{ name: "Beach Club", contact_email: null, admin_user_id: "1f44de6e-71da-4256-90e9-00b339b5bdbd" }],
      users: [{ email: "owner@club.com" }],
      provider_members: [],
    }) as any;

    await handler.handle(EVENT);

    expect(mail.sendMail).toHaveBeenCalledTimes(1);
    expect(mail.sendMail.mock.calls[0][0].to).toBe("owner@club.com");
    // Desk (walk-in) booking → name from the label, no phone.
    expect(mail.sendMail.mock.calls[0][0].text).toContain("Walk-in Bob");
    expect(mail.sendMail.mock.calls[0][0].text).toContain("Phone: —");
  });

  it("returns without sending on a payload with no bookingId", async () => {
    global.fetch = mockFetch({}) as any;
    await handler.handle({ ...EVENT, payload: {} });
    expect(mail.sendMail).not.toHaveBeenCalled();
  });
});
