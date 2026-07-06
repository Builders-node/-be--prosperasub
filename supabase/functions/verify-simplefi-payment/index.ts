import { serve } from "https://deno.land/std@0.190.0/http/server.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

const SIMPLEFI_API = "https://api.simplefi.tech";

serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }

  try {
    const { payment_id } = await req.json();

    if (!payment_id) {
      throw new Error("Missing payment_id");
    }

    const token = Deno.env.get("SIMPLEFI_API_TOKEN");
    if (!token) {
      throw new Error("Infinita payment system not configured");
    }

    const res = await fetch(`${SIMPLEFI_API}/payment_requests/${payment_id}`, {
      method: "GET",
      headers: {
        Authorization: `Bearer ${token}`,
      },
    });

    if (!res.ok) {
      const errorText = await res.text();
      console.error("SimpleFi status check error:", errorText);
      throw new Error("Failed to check payment status");
    }

    const data = await res.json();
    const status = String(data.status || "pending").toLowerCase();
    const SUCCESS = ["approved", "paid", "confirmed", "completed"];
    const isPaid = SUCCESS.includes(status) || (status === "expired" && data.status_detail === "correct");

    return new Response(
      JSON.stringify({
        paid: isPaid,
        status,
        payment_id,
      }),
      {
        status: 200,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      }
    );
  } catch (error: any) {
    console.error("Error verifying SimpleFi payment:", error);
    return new Response(
      JSON.stringify({ error: error.message }),
      {
        status: 500,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      }
    );
  }
});
