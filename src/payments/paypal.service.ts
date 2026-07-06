import { Injectable, ServiceUnavailableException } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";

@Injectable()
export class PayPalService {
  constructor(private readonly config: ConfigService) {}

  /** Public config the frontend needs to render the PayPal buttons. */
  getPublicConfig() {
    return {
      clientId: this.clientId,
      env: this.env,
      enabled: Boolean(this.clientId && this.clientSecret),
    };
  }

  /** Create a PayPal order (intent CAPTURE) for the given USD amount in cents. */
  async createOrder(input: { amountCents: number; description?: string }) {
    this.assertConfigured();
    const value = (input.amountCents / 100).toFixed(2);

    const res = await this.fetchPayPal("/v2/checkout/orders", {
      method: "POST",
      body: JSON.stringify({
        intent: "CAPTURE",
        purchase_units: [
          {
            amount: { currency_code: "USD", value },
            description: (input.description ?? "ProsperaSub payment").slice(0, 127),
          },
        ],
      }),
    });

    if (!res.id) {
      throw new ServiceUnavailableException("PayPal did not return an order id.");
    }
    return { id: res.id as string, status: res.status as string, provider: "paypal" };
  }

  /** Capture an approved PayPal order. Idempotent: an already-captured order
   *  resolves as paid instead of throwing, so a retried capture recovers a
   *  lost response without taking the money twice. */
  async captureOrder(orderId: string) {
    this.assertConfigured();
    try {
      const res = await this.fetchPayPal(`/v2/checkout/orders/${orderId}/capture`, {
        method: "POST",
        body: "{}",
      });
      const capture = res?.purchase_units?.[0]?.payments?.captures?.[0];
      const paid = res?.status === "COMPLETED" || capture?.status === "COMPLETED";
      return { paid: Boolean(paid), capture_id: capture?.id ?? orderId, status: res?.status ?? "unknown", provider: "paypal" };
    } catch (err) {
      // If it was already captured, treat as paid by reading the order status.
      const order = await this.getOrder(orderId).catch(() => null);
      if (order?.status === "COMPLETED") {
        const capture = order?.purchase_units?.[0]?.payments?.captures?.[0];
        return { paid: true, capture_id: capture?.id ?? orderId, status: "COMPLETED", provider: "paypal" };
      }
      throw err;
    }
  }

  /** Read a PayPal order (used to verify/recover capture status). */
  async getOrder(orderId: string) {
    this.assertConfigured();
    return this.fetchPayPal(`/v2/checkout/orders/${orderId}`, { method: "GET" });
  }

  // ── internals ──────────────────────────────────────────────────────────────
  private async getAccessToken(): Promise<string> {
    const auth = Buffer.from(`${this.clientId}:${this.clientSecret}`).toString("base64");
    const res = await fetch(`${this.baseUrl}/v1/oauth2/token`, {
      method: "POST",
      headers: {
        Authorization: `Basic ${auth}`,
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: "grant_type=client_credentials",
    });
    if (!res.ok) {
      throw new ServiceUnavailableException(`PayPal auth failed (HTTP ${res.status}).`);
    }
    const data = await res.json();
    if (!data.access_token) throw new ServiceUnavailableException("PayPal did not return an access token.");
    return data.access_token as string;
  }

  private async fetchPayPal(path: string, init: RequestInit) {
    const token = await this.getAccessToken();
    const res = await fetch(`${this.baseUrl}${path}`, {
      ...init,
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      const msg = data?.message || data?.details?.[0]?.description || `PayPal returned HTTP ${res.status}.`;
      throw new ServiceUnavailableException(msg);
    }
    return data;
  }

  private assertConfigured() {
    if (!this.clientId || !this.clientSecret) {
      throw new ServiceUnavailableException("PayPal payments are not configured.");
    }
  }

  private get clientId() {
    return this.config.get<string>("PAYPAL_CLIENT_ID") || "";
  }
  private get clientSecret() {
    return this.config.get<string>("PAYPAL_CLIENT_SECRET") || "";
  }
  private get env() {
    return (this.config.get<string>("PAYPAL_ENV") || "sandbox").toLowerCase() === "live" ? "live" : "sandbox";
  }
  private get baseUrl() {
    return this.env === "live" ? "https://api-m.paypal.com" : "https://api-m.sandbox.paypal.com";
  }
}
