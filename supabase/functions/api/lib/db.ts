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

/**
 * Every row of a query, page by page. PostgREST truncates a plain select at
 * db-max-rows with HTTP 200 and no flag, so anything summed into a number must
 * come through here. `build` must apply a deterministic order.
 */
export async function fetchAll<T>(
  build: () => { range: (from: number, to: number) => PromiseLike<{ data: T[] | null; error: unknown }> },
  pageSize = 1000,
): Promise<T[]> {
  const out: T[] = [];
  for (let from = 0; ; from += pageSize) {
    const { data, error } = await build().range(from, from + pageSize - 1);
    if (error) throw error;
    out.push(...(data ?? []));
    if (!data || data.length < pageSize) return out;
  }
}
