import { serve } from "https://deno.land/std@0.190.0/http/server.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

const SIMPLEFI_API = "https://api.simplefi.tech";
const MERCHANT_ID = "6a2b674f53d0c31cce8c7557";

serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }

  try {
    const { amount_cents, description, reference } = await req.json();

    console.log("=== CREATE SIMPLEFI INVOICE START ===");
    console.log("Amount (cents):", amount_cents);
    console.log("Description:", description);

    if (!amount_cents || amount_cents <= 0) {
      throw new Error("Invalid amount_cents");
    }

    const token = Deno.env.get("SIMPLEFI_API_TOKEN");
    if (!token) {
      console.error("Missing SIMPLEFI_API_TOKEN environment variable");
      throw new Error("Infinita payment system not configured");
    }

    const amountUsd = amount_cents / 100;

    const payload = {
      amount: amountUsd,
      currency: "USD",
      card_payment: false,
      merchant_id: MERCHANT_ID,
      reference: {
        description: description || "ProsperaSub Payment",
        ...(reference || {}),
      },
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
    console.log("Full SimpleFi response:", JSON.stringify(data));

    return new Response(
      JSON.stringify({
        payment_id: paymentId,
        checkout_url: checkoutUrl,
        status: data.status || "pending",
        // Native wallet payment fields (from SimpleFi)
        destination_address: data.destination_address || data.wallet_address || data.recipient || null,
        token_mint: data.token_mint || data.mint_address || data.token_address || null,
        token_amount: data.token_amount || data.amount_token || null,
        memo: data.memo || data.reference_id || paymentId,
        amount_usd: amountUsd,
      }),
      {
        status: 200,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      }
    );
  } catch (error: any) {
    console.error("Error creating SimpleFi invoice:", error);
    return new Response(
      JSON.stringify({ error: error.message || "Unexpected error" }),
      {
        status: 200,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      }
    );
  }
});
