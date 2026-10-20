import { createClient, type SupabaseClient } from "@supabase/supabase-js";

/**
 * Service-role client. Supabase injects SUPABASE_URL and
 * SUPABASE_SERVICE_ROLE_KEY into every Edge Function, so nothing is configured
 * by hand. Server-side only — this bypasses RLS, exactly as the Nest backend's
 * PostgREST calls did.
 */
let client: SupabaseClient | null = null;

export function db(): SupabaseClient {
  if (!client) {
    client = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!, {
      auth: { persistSession: false, autoRefreshToken: false },
    });
  }
  return client;
}
