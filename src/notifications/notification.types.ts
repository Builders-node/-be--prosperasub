export type AdminPaymentNotificationPayload = {
  provider: string;
  providerPaymentId: string;
  serviceName: string;
  clientName?: string | null;
  clientEmail?: string | null;
  clientPhone?: string | null;
  amountCents?: number | null;
  amountSats?: number | null;
  currency?: string | null;
  planName?: string | null;
  duration?: string | null;
  bookingId?: string | null;
  adminUrl?: string | null;
  selectedDateTime?: string | null;
  paymentStatus?: string | null;
  paidAt?: Date | string | null;
};

export type NotificationSendResult = {
  sent: boolean;
  provider: string;
  id?: string;
  reason?: string;
};
