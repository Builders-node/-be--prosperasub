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
    const { payment_hash } = await req.json();

    console.log("=== VERIFY PAYMENT START ===");
    console.log("Payment hash:", payment_hash);

    if (!payment_hash) {
      throw new Error("Missing payment_hash");
    }

    // Use platform-wide LNbits configuration from environment
    const lnbitsUrl = Deno.env.get("LNBITS_URL");
    const lnbitsApiKey = Deno.env.get("LNBITS_API_KEY");

    if (!lnbitsUrl || !lnbitsApiKey) {
      console.error("Missing LNBITS_URL or LNBITS_API_KEY environment variables");
      throw new Error("Payment system not configured");
    }

    // Check payment status from LNbits
    const checkResponse = await fetch(`${lnbitsUrl}/api/v1/payments/${payment_hash}`, {
      method: "GET",
      headers: {
        "X-Api-Key": lnbitsApiKey,
      },
    });

    if (!checkResponse.ok) {
      const errorText = await checkResponse.text();
      console.error("LNbits check error:", errorText);
      throw new Error("Failed to check payment status");
    }

    const paymentData = await checkResponse.json();
    
    // Check if preimage exists and is valid (non-empty, non-zero)
    const hasValidPreimage =
      paymentData.preimage &&
      paymentData.preimage !== "" &&
      paymentData.preimage !== "0000000000000000000000000000000000000000000000000000000000000000" &&
      paymentData.preimage.length === 64;

    const hasValidDetailsPreimage =
      paymentData.details?.preimage &&
      paymentData.details.preimage !== "" &&
      paymentData.details.preimage !== "0000000000000000000000000000000000000000000000000000000000000000" &&
      paymentData.details.preimage.length === 64;

    const isPaid =
      hasValidPreimage ||
      hasValidDetailsPreimage ||
      paymentData.paid === true ||
      paymentData.paid === "true" ||
      paymentData.pending === false ||
      paymentData.details?.pending === false ||
      paymentData.details?.status === "complete" ||
      paymentData.details?.status === "success";

    console.log("=== VERIFY PAYMENT RESULT ===");
    console.log("Is paid:", isPaid);

    return new Response(
      JSON.stringify({
        paid: isPaid,
        payment_hash: payment_hash,
      }),
      {
        status: 200,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      }
    );
  } catch (error: any) {
    console.error("Error verifying payment:", error);
    return new Response(
      JSON.stringify({ error: error.message }),
      {
        status: 500,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      }
    );
  }
});
