import { buildAllowedOrigins, publicAppUrl, PRIMARY_APP_ORIGIN } from "./app-origins";

/**
 * This list is the difference between a working site and a blank page: an
 * origin missing from it fails every browser request with a CORS error, and
 * nothing in a build or a type check can catch that. Production previously had
 * no fallback at all here — the whole list came from an env var.
 */
describe("app origins", () => {
  it("allows the primary domain with no configuration whatsoever", () => {
    const origins = buildAllowedOrigins(undefined, false);
    expect(origins.has("https://everysub.net")).toBe(true);
    expect(origins.has("https://www.everysub.net")).toBe(true);
  });

  it("still allows the old domain", () => {
    // It redirects at the edge, but a redirect only helps a browser navigating
    // to a page. An XHR from an already-open tab, or a QR printed before the
    // move, still arrives with the old Origin and must not be refused.
    const origins = buildAllowedOrigins(undefined, false);
    expect(origins.has("https://prosperasub.com")).toBe(true);
    expect(origins.has("https://www.prosperasub.com")).toBe(true);
  });

  it("keeps localhost out of production", () => {
    expect(buildAllowedOrigins(undefined, false).has("http://localhost:8080")).toBe(false);
    expect(buildAllowedOrigins(undefined, true).has("http://localhost:8080")).toBe(true);
  });

  it("adds configured origins and tolerates the shapes people actually type", () => {
    const origins = buildAllowedOrigins(
      " https://staging.everysub.net , https://preview.everysub.net/ ,, ",
      false,
    );
    expect(origins.has("https://staging.everysub.net")).toBe(true);
    // Trailing slash stripped — an Origin header never carries one, so
    // "https://preview.everysub.net/" would have matched nothing.
    expect(origins.has("https://preview.everysub.net")).toBe(true);
    expect(origins.has("")).toBe(false);
  });

  it("never lets configuration remove a built-in origin", () => {
    // A typo'd env var must not be able to lock the primary domain out.
    const origins = buildAllowedOrigins("https://something-else.example", false);
    expect(origins.has(PRIMARY_APP_ORIGIN)).toBe(true);
  });

  it("builds email links against the primary domain by default", () => {
    expect(publicAppUrl(undefined)).toBe("https://everysub.net");
    expect(publicAppUrl("")).toBe("https://everysub.net");
    expect(publicAppUrl("  ")).toBe("https://everysub.net");
    // Trailing slash stripped so callers can append "/path" without doubling up.
    expect(publicAppUrl("https://everysub.net/")).toBe("https://everysub.net");
    expect(publicAppUrl("https://staging.everysub.net")).toBe("https://staging.everysub.net");
  });
});
