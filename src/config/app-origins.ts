/**
 * Which web origins this API belongs to.
 *
 * Two separate allow-lists used to be maintained by hand in two files, and they
 * had drifted: `allowedRedirectOrigins` (OAuth) hard-coded prosperasub.com,
 * while CORS had NO production fallback at all — the entire list came from
 * `API_ALLOWED_ORIGINS`, so an unset or mistyped env var didn't degrade the
 * site, it took every browser request down with it. Adding a second domain by
 * editing both lists separately is exactly how that gap reappears.
 *
 * Both now read from here. Env vars still extend the list, so a preview domain
 * or a future rebrand needs no deploy.
 */

/** The canonical public site. Everything else redirects here. */
export const PRIMARY_APP_ORIGIN = "https://everysub.net";

/**
 * Origins that always work, whatever the environment says.
 *
 * prosperasub.com stays listed on purpose. It redirects to the primary domain
 * at the edge, but a redirect only helps a browser navigating to a page — an
 * in-flight XHR from an already-loaded tab, a bookmarked deep link, or an
 * access QR printed before the move all still arrive with the old Origin
 * header. Dropping it would break those with a CORS error rather than a
 * redirect.
 */
const ALWAYS_ALLOWED = [
  PRIMARY_APP_ORIGIN,
  "https://www.everysub.net",
  "https://prosperasub.com",
  "https://www.prosperasub.com",
] as const;

const LOCAL_ORIGINS = [
  "http://localhost:8080",
  "http://127.0.0.1:8080",
  "http://localhost:8081",
  "http://127.0.0.1:8081",
] as const;

function fromEnv(raw: string | undefined): string[] {
  return (raw || "")
    .split(",")
    .map((origin) => origin.trim().replace(/\/$/, ""))
    .filter(Boolean);
}

/**
 * @param configured comma-separated origins from the environment
 * @param includeLocal add the dev servers (non-production only)
 */
export function buildAllowedOrigins(configured: string | undefined, includeLocal: boolean): Set<string> {
  const origins = new Set<string>([...ALWAYS_ALLOWED, ...fromEnv(configured)]);
  if (includeLocal) LOCAL_ORIGINS.forEach((o) => origins.add(o));
  return origins;
}

/** Public site URL for links in emails and partner payloads. */
export function publicAppUrl(configured: string | undefined): string {
  return (configured?.trim() || PRIMARY_APP_ORIGIN).replace(/\/$/, "");
}
