import { serve } from "https://deno.land/std@0.190.0/http/server.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

const SIMPLEFI_API = "https://api.simplefi.tech";
// Falls back only if SIMPLEFI_MERCHANT_ID env is missing. Owns the wallet
// that receives LIVES — override in Supabase Edge Function secrets.
const MERCHANT_ID_FALLBACK = "6a2b674f53d0c31cce8c7557";
// Where SimpleFi posts status updates. Must be publicly reachable. Falls back
// to prod API — override via env for staging.
const NOTIFICATION_URL_FALLBACK = "https://api.prosperasub.com/webhooks/simplefi";
// Restrict SimpleFi checkout to LIVES on Solana. Merchant currently has only
// LIVES enabled — sending this explicitly stops customers from being offered
// any other token if the merchant ever enables one.
const COINS = [{ chain_id: 900, ticker: "LIVES" }];

serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }

  try {
    const body = await req.json();
    const {
      amount_cents,
      description,
      reference,
      // New: routing hints the webhook needs to find the right subscription
      // when SimpleFi calls us back. `service` tags the table (cleaning|food|
      // beach|rental|test), `order_id` is the row id or a test correlation id.
      service,
      order_id,
    } = body ?? {};

    console.log("=== CREATE SIMPLEFI INVOICE START ===");
    console.log("Amount (cents):", amount_cents, "service:", service, "order_id:", order_id);

    if (!amount_cents || amount_cents <= 0) {
      throw new Error("Invalid amount_cents");
    }

    const token = Deno.env.get("SIMPLEFI_API_TOKEN");
    if (!token) {
      console.error("Missing SIMPLEFI_API_TOKEN environment variable");
      throw new Error("Infinita payment system not configured");
    }

    // Merchant + notification env resolution with loud warnings when missing.
    const merchantIdFromEnv = (Deno.env.get("SIMPLEFI_MERCHANT_ID") || "").trim();
    const merchantId = merchantIdFromEnv || MERCHANT_ID_FALLBACK;
    if (!merchantIdFromEnv) {
      console.warn(
        `[SimpleFi] SIMPLEFI_MERCHANT_ID not set — using hardcoded fallback ${MERCHANT_ID_FALLBACK}.`,
      );
    }
    const notificationUrl =
      (Deno.env.get("SIMPLEFI_NOTIFICATION_URL") || "").trim() || NOTIFICATION_URL_FALLBACK;

    console.log("[SimpleFi] merchant_id:", merchantId);
    console.log("[SimpleFi] notification_url:", notificationUrl);

    const amountUsd = amount_cents / 100;

    // reference is echoed back to us verbatim in the webhook — pack routing
    // info the receiver needs so it can find the right subscription row.
    const finalReference: Record<string, unknown> = {
      description: description || "ProsperaSub Payment",
      ...(reference || {}),
    };
    if (service && !finalReference.service) finalReference.service = service;
    if (order_id && !finalReference.orderId) finalReference.orderId = order_id;

    const payload = {
      amount: amountUsd,
      currency: "USD",
      card_payment: false,
      merchant_id: merchantId,
      notification_url: notificationUrl,
      coins: COINS,
      reference: finalReference,
    };

    const res = await fetch(`${SIMPLEFI_API}/payment_requests`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(payload),
    });

    if (!res.ok) {
      const errorText = await res.text();
      console.error("SimpleFi API error:", res.status, errorText);
      throw new Error("Failed to create Infinita payment request");
    }

    const data = await res.json();
    const paymentId = data.id || data._id;
    const checkoutUrl = data.checkout_v2_url || data.checkout_url;

    console.log("=== CREATE SIMPLEFI INVOICE SUCCESS ===");
    console.log("Payment ID:", paymentId);
    console.log("Checkout URL:", checkoutUrl);
    console.log("Destination wallet from SimpleFi:", data.destination_address || data.wallet_address || data.recipient || "n/a");
    console.log("SimpleFi echoed merchant_id:", data.merchant_id || data.merchant?.id || "n/a");
    // First transaction contains the intermediate address + Solana Pay reference
    const firstTx = Array.isArray(data.transactions) && data.transactions[0];
    if (firstTx) {
      console.log("First tx address:", firstTx.address);
      console.log("First tx additional_info:", JSON.stringify(firstTx.additional_info));
    }

    return new Response(
      JSON.stringify({
        payment_id: paymentId,
        checkout_url: checkoutUrl,
        status: data.status || "pending",
        destination_address: data.destination_address || data.wallet_address || data.recipient || firstTx?.address || null,
        token_mint: data.token_mint || data.mint_address || data.token_address || firstTx?.additional_info?.token_mint || null,
        token_amount: data.token_amount || data.amount_token || null,
        memo: data.memo || data.reference_id || paymentId,
        amount_usd: amountUsd,
      }),
      {
        status: 200,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      }
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unexpected error";
    console.error("Error creating SimpleFi invoice:", message);
    return new Response(
      JSON.stringify({ error: message }),
      {
        status: 200,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      }
    );
  }
});
