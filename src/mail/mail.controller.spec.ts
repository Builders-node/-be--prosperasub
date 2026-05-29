import { ForbiddenException, UnauthorizedException } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { SessionService } from "../auth/session.service";
import { MailController } from "./mail.controller";

describe("MailController", () => {
  const sessions = new SessionService(new ConfigService());
  const mail = {
    sendPaymentConfirmationEmail: jest.fn().mockResolvedValue({ sent: true })
  };
  const controller = new MailController(mail as any, sessions);

  const body = {
    planName: "1 Bedroom & Studio",
    monthlyPriceCents: 7900,
    totalCents: 7900,
    billingPeriodMonths: 1,
    serviceStartDate: "2026-06-01",
    serviceEndDate: "2026-07-01",
    paidUntil: "2026-07-01"
  };

  beforeEach(() => {
    mail.sendPaymentConfirmationEmail.mockClear();
  });

  it("requires an access token", async () => {
    await expect(controller.sendPaymentConfirmation(undefined, body)).rejects.toBeInstanceOf(UnauthorizedException);
  });

  it("sends to the authenticated email", async () => {
    const token = await sessions.createTokenPair({
      userId: "user-1",
      roles: ["USER"],
      email: "user@example.com",
      name: "User"
    });

    const result = await controller.sendPaymentConfirmation(`Bearer ${token.accessToken}`, body);

    expect(result).toEqual({ sent: true });
    expect(mail.sendPaymentConfirmationEmail).toHaveBeenCalledWith(expect.objectContaining({
      to: "user@example.com",
      customerName: "User"
    }));
  });

  it("blocks regular users from sending to a different email", async () => {
    const token = await sessions.createTokenPair({
      userId: "user-1",
      roles: ["USER"],
      email: "user@example.com",
      name: "User"
    });

    await expect(
      controller.sendPaymentConfirmation(`Bearer ${token.accessToken}`, {
        ...body,
        email: "other@example.com"
      })
    ).rejects.toBeInstanceOf(ForbiddenException);
  });
});
