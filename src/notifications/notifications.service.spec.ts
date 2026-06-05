import { NotificationsService } from "./notifications.service";

describe("NotificationsService", () => {
  const prisma = {
    isAvailable: jest.fn(() => true),
    paymentCheckoutSession: {
      upsert: jest.fn(),
      findUnique: jest.fn()
    },
    adminPaymentNotification: {
      findUnique: jest.fn(),
      create: jest.fn(),
      update: jest.fn(),
      findMany: jest.fn()
    }
  };

  const email = {
    sendAdminPaymentNotification: jest.fn()
  };

  const telegram = {
    sendAdminPaymentNotification: jest.fn()
  };

  let service: NotificationsService;

  beforeEach(() => {
    jest.clearAllMocks();
    prisma.isAvailable.mockReturnValue(true);
    service = new NotificationsService(prisma as never, email as never, telegram as never);
  });

  it("sends email and Telegram for a successful payment", async () => {
    prisma.adminPaymentNotification.findUnique.mockResolvedValue(null);
    prisma.adminPaymentNotification.create.mockResolvedValue({
      id: "notification-1",
      emailStatus: "pending",
      telegramStatus: "pending"
    });
    prisma.adminPaymentNotification.update.mockImplementation(({ data }: { data: Record<string, unknown> }) =>
      Promise.resolve({ id: "notification-1", ...data })
    );
    email.sendAdminPaymentNotification.mockResolvedValue({ sent: true, provider: "resend" });
    telegram.sendAdminPaymentNotification.mockResolvedValue({ sent: true, provider: "telegram" });

    const result = await service.notifyPaymentSucceeded({
      provider: "blink",
      providerPaymentId: "hash",
      serviceName: "Cleaning subscription",
      clientEmail: "customer@example.com",
      amountCents: 7900,
      currency: "USD",
      paidAt: new Date("2026-05-26T12:00:00Z")
    });

    expect(result.skipped).toBe(false);
    expect(email.sendAdminPaymentNotification).toHaveBeenCalled();
    expect(telegram.sendAdminPaymentNotification).toHaveBeenCalled();
    expect(prisma.adminPaymentNotification.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          emailStatus: "sent",
          telegramStatus: "sent"
        })
      })
    );
  });

  it("does not send duplicate notifications when both channels already succeeded", async () => {
    prisma.adminPaymentNotification.findUnique.mockResolvedValue({
      id: "notification-1",
      emailStatus: "sent",
      telegramStatus: "sent"
    });

    const result = await service.notifyPaymentSucceeded({
      provider: "blink",
      providerPaymentId: "hash",
      serviceName: "Cleaning subscription"
    });

    expect(result.skipped).toBe(true);
    expect(email.sendAdminPaymentNotification).not.toHaveBeenCalled();
    expect(telegram.sendAdminPaymentNotification).not.toHaveBeenCalled();
  });

  it("keeps the payment flow successful when notification channels fail", async () => {
    prisma.adminPaymentNotification.findUnique.mockResolvedValue(null);
    prisma.adminPaymentNotification.create.mockResolvedValue({
      id: "notification-1",
      emailStatus: "pending",
      telegramStatus: "pending"
    });
    prisma.adminPaymentNotification.update.mockImplementation(({ data }: { data: Record<string, unknown> }) =>
      Promise.resolve({ id: "notification-1", ...data })
    );
    email.sendAdminPaymentNotification.mockRejectedValue(new Error("resend down"));
    telegram.sendAdminPaymentNotification.mockResolvedValue({
      sent: false,
      provider: "telegram",
      reason: "missing_telegram_config"
    });

    const result = await service.notifyPaymentSucceeded({
      provider: "blink",
      providerPaymentId: "hash",
      serviceName: "Cleaning subscription"
    });

    expect(result.skipped).toBe(false);
    expect(prisma.adminPaymentNotification.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          emailStatus: "failed",
          telegramStatus: "skipped"
        })
      })
    );
  });
});
