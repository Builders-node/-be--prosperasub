import { ConfigService } from "@nestjs/config";
import { MailService } from "./mail.service";

describe("MailService", () => {
  const originalFetch = global.fetch;

  afterEach(() => {
    global.fetch = originalFetch;
    jest.restoreAllMocks();
  });

  it("does not throw when Resend is not configured", async () => {
    const service = new MailService(new ConfigService({ NODE_ENV: "test" }));

    const result = await service.sendPasswordResetEmail({
      to: "user@example.com",
      resetUrl: "http://localhost:8080/reset-password?token=example"
    });

    expect(result).toEqual({
      sent: false,
      provider: "resend",
      reason: "missing_resend_api_key"
    });
  });

  it("sends payment confirmation through Resend when configured", async () => {
    const fetchMock = jest.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ id: "email_123" })
    });
    global.fetch = fetchMock as any;
    const service = new MailService(
      new ConfigService({
        RESEND_API_KEY: "resend-key",
        MAIL_FROM: "ProsperaSub <no-reply@prosperasub.com>"
      })
    );

    const result = await service.sendPaymentConfirmationEmail({
      to: "user@example.com",
      customerName: "User",
      planName: "1 Bedroom & Studio",
      monthlyPriceCents: 7900,
      totalCents: 15800,
      billingPeriodMonths: 2,
      serviceStartDate: "2026-06-01",
      serviceEndDate: "2026-08-01",
      paidUntil: "2026-08-01",
      paymentReference: "payment-reference",
      apartmentNote: "Duna Tower, Apt 1204"
    });

    expect(result).toEqual({ sent: true, provider: "resend", id: "email_123" });
    expect(fetchMock).toHaveBeenCalledWith(
      "https://api.resend.com/emails",
      expect.objectContaining({
        method: "POST",
        headers: expect.objectContaining({
          Authorization: "Bearer resend-key",
          "Content-Type": "application/json"
        })
      })
    );
  });
});
