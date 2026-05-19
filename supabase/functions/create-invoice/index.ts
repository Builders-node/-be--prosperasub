import { serve } from "https://deno.land/std@0.190.0/http/server.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }

  try {
    const { amount_sats, description } = await req.json();

    console.log("=== CREATE INVOICE START ===");
    console.log("Amount (sats):", amount_sats);
    console.log("Description:", description);

    if (!amount_sats || amount_sats <= 0) {
      throw new Error("Invalid amount_sats");
    }

    // Use platform-wide LNbits configuration from environment
    const lnbitsUrl = Deno.env.get("LNBITS_URL");
    const lnbitsApiKey = Deno.env.get("LNBITS_API_KEY");

    if (!lnbitsUrl || !lnbitsApiKey) {
      console.error("Missing LNBITS_URL or LNBITS_API_KEY environment variables");
      throw new Error("Payment system not configured");
    }

    console.log("Using platform LNbits configuration");

    // Create LNbits invoice
    let lnbitsResponse;
    try {
      lnbitsResponse = await fetch(`${lnbitsUrl}/api/v1/payments`, {
        method: "POST",
        headers: {
          "X-Api-Key": lnbitsApiKey,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          out: false,
          amount: amount_sats,
          memo: description || "Subscription Payment",
        }),
      });
    } catch (fetchError) {
      console.error("LNbits fetch failed (network error):", fetchError);
      return new Response(
        JSON.stringify({
          error: "Lightning payment service is unreachable. Please try again later or use FIAT/CRYPTO.",
          fallback: true,
        }),
        { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    if (!lnbitsResponse.ok) {
      const errorText = await lnbitsResponse.text();
      console.error("LNbits error:", lnbitsResponse.status, errorText);
      return new Response(
        JSON.stringify({
          error: "Lightning payment service is temporarily unavailable. Please try again later or use FIAT/CRYPTO.",
          fallback: true,
        }),
        { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    const lnbitsData = await lnbitsResponse.json();
    const paymentRequest = lnbitsData.payment_request;
    const paymentHash = lnbitsData.payment_hash;

    console.log("=== CREATE INVOICE SUCCESS ===");
    console.log("Payment hash:", paymentHash);

    return new Response(
      JSON.stringify({
        payment_request: paymentRequest,
        payment_hash: paymentHash,
        amount: amount_sats,
        verification_type: "auto",
      }),
      {
        status: 200,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      }
    );
  } catch (error: any) {
    console.error("Error creating invoice:", error);
    return new Response(
      JSON.stringify({ error: error.message || "Unexpected error", fallback: true }),
      {
        status: 200,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      }
    );
  }
});
