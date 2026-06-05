import { BadRequestException } from "@nestjs/common";
import { CatalogService } from "../catalog/catalog.service";
import { BlinkService } from "./blink.service";
import { PaymentsController } from "./payments.controller";

describe("PaymentsController", () => {
  const blink = {
    createUsdInvoice: jest.fn(),
    getPaymentStatus: jest.fn()
  } as unknown as BlinkService;

  const notifications = {
    recordCheckoutSession: jest.fn(),
    notifyPaymentSucceededForProviderRef: jest.fn()
  };

  const controller = new PaymentsController(blink, new CatalogService(), notifications as never);

  beforeEach(() => {
    jest.clearAllMocks();
  });

  it("creates a cleaning invoice from the server-calculated multi-month total", async () => {
    (blink.createUsdInvoice as jest.Mock).mockResolvedValue({ payment_hash: "hash", amount_sats: 1000 });

    const invoice = await controller.createInvoice({
      amount_cents: 23700,
      amount_sats: 1000,
      context: "cleaning_subscription",
      package_id: "cleaning-1-bedroom-studio",
      billing_period_months: 3,
      description: "Cleaning - 1 Bedroom & Studio - 3 months",
      external_id: "cleaning-test"
    });

    expect(invoice).toEqual({ payment_hash: "hash", amount_sats: 1000 });
    expect(blink.createUsdInvoice).toHaveBeenCalledWith({
      amountCents: 23700,
      memo: "Cleaning - 1 Bedroom & Studio - 3 months",
      externalId: "cleaning-test"
    });
    expect(notifications.recordCheckoutSession).toHaveBeenCalledWith(
      expect.objectContaining({
        provider: "blink",
        providerPaymentId: "hash",
        context: "cleaning_subscription",
        serviceName: "Cleaning subscription",
        planName: "1 Bedroom & Studio",
        duration: "3 months",
        amountCents: 23700,
        amountSats: 1000
      })
    );
  });

  it("rejects manipulated cleaning totals", async () => {
    await expect(
      controller.createInvoice({
        amount_cents: 1,
        context: "cleaning_subscription",
        package_id: "cleaning-2-bedroom",
        billing_period_months: 2,
        description: "Cleaning - 2 Bedroom"
      })
    ).rejects.toThrow(BadRequestException);

    expect(blink.createUsdInvoice).not.toHaveBeenCalled();
  });

  it("accepts cleaning invoices using admin-entered monthly override pricing", async () => {
    (blink.createUsdInvoice as jest.Mock).mockResolvedValue({ payment_hash: "hash-monthly", amount_sats: 1000 });
    const catalog = {
      getCleaningPackage: jest.fn().mockResolvedValue({
        id: "cowork-monthly",
        name: "Cowork Monthly",
        description: "Manual monthly plan",
        pricePerCleaningCents: 1000,
        monthlyPriceCents: 25500,
        pricingMode: "fixed_monthly_price",
        frequencyUnit: "month",
        frequencyCount: 26,
        customFrequencyLabel: null,
        isActive: true,
      }),
    };
    const monthlyController = new PaymentsController(blink, catalog as never, notifications as never);

    await monthlyController.createInvoice({
      amount_cents: 25500,
      amount_sats: 1000,
      context: "cleaning_subscription",
      package_id: "cowork-monthly",
      billing_period_months: 1,
      description: "Cleaning - Cowork Monthly",
    });

    expect(blink.createUsdInvoice).toHaveBeenCalledWith({
      amountCents: 25500,
      memo: "Cleaning - Cowork Monthly",
      externalId: undefined,
    });
  });

  it("sends admin notifications after confirmed payment", async () => {
    (blink.getPaymentStatus as jest.Mock).mockResolvedValue({
      paid: true,
      payment_hash: "hash",
      status: "paid"
    });

    const status = await controller.paymentStatus({
      payment_hash: "hash",
      service_name: "Cleaning subscription",
      client_email: "customer@example.com",
      plan_name: "1 Bedroom & Studio",
      duration: "1 month"
    });

    expect(status.paid).toBe(true);
    expect(notifications.notifyPaymentSucceededForProviderRef).toHaveBeenCalledWith(
      "blink",
      "hash",
      expect.objectContaining({
        serviceName: "Cleaning subscription",
        clientEmail: "customer@example.com",
        planName: "1 Bedroom & Studio",
        duration: "1 month",
        paymentStatus: "paid"
      })
    );
  });

  it("sends admin notifications for confirmed admin test payments", async () => {
    (blink.getPaymentStatus as jest.Mock).mockResolvedValue({
      paid: true,
      payment_hash: "admin-test-hash",
      status: "paid"
    });

    const status = await controller.paymentStatus({
      payment_hash: "admin-test-hash",
      service_name: "Admin test payment",
      client_name: "ProsperaSub admin",
      plan_name: "Blink health check",
      duration: "One time",
      booking_id: "admin-test-payment",
      admin_url: "https://prosperasub.com/admin/payments"
    });

    expect(status.paid).toBe(true);
    expect(notifications.notifyPaymentSucceededForProviderRef).toHaveBeenCalledWith(
      "blink",
      "admin-test-hash",
      expect.objectContaining({
        serviceName: "Admin test payment",
        clientName: "ProsperaSub admin",
        planName: "Blink health check",
        duration: "One time",
        bookingId: "admin-test-payment",
        adminUrl: "https://prosperasub.com/admin/payments",
        paymentStatus: "paid"
      })
    );
  });
});
