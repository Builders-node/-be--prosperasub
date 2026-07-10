import { serve } from "https://deno.land/std@0.190.0/http/server.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

const SIMPLEFI_API = "https://api.simplefi.tech";

// SimpleFi statuses that count as a completed payment.
const SUCCESS = new Set(["approved", "paid", "confirmed", "completed"]);
// Terminal failures — never going to become paid. Frontend stops polling on
// these and shows an error state instead of a spinner.
const TERMINAL_FAIL = new Set(["expired", "canceled", "cancelled", "failed", "refunded"]);

serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }

  try {
    const { payment_id } = await req.json();
    if (!payment_id) throw new Error("Missing payment_id");

    const token = Deno.env.get("SIMPLEFI_API_TOKEN");
    if (!token) throw new Error("Infinita payment system not configured");

    const res = await fetch(`${SIMPLEFI_API}/payment_requests/${payment_id}`, {
      method: "GET",
      headers: { Authorization: `Bearer ${token}` },
    });

    if (!res.ok) {
      const errorText = await res.text();
      console.error("SimpleFi status check error:", res.status, errorText);
      throw new Error("Failed to check payment status");
    }

    const data = await res.json();
    const status = String(data.status || "pending").toLowerCase();
    const statusDetail = String(data.status_detail || "").toLowerCase();

    // "expired + correct" is SimpleFi's way of saying "we expired the request
    // but the funds did land on-chain in the correct amount" — count as paid.
    const isExpiredButCorrect = status === "expired" && statusDetail === "correct";

    const paid = SUCCESS.has(status) || isExpiredButCorrect;
    // Once terminal, polling has to stop. Refund is terminal even after a
    // prior success — the money went back.
    const terminal = paid || TERMINAL_FAIL.has(status);

    return new Response(
      JSON.stringify({
        paid,
        terminal,
        status,
        status_detail: statusDetail || null,
        payment_id,
      }),
      {
        status: 200,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      }
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unexpected error";
    console.error("Error verifying SimpleFi payment:", message);
    return new Response(
      JSON.stringify({ error: message }),
      {
        status: 500,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      }
    );
  }
});
