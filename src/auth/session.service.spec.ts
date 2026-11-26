import { ConfigService } from "@nestjs/config";
import { SessionService } from "./session.service";

describe("SessionService", () => {
  const config = new ConfigService({
    JWT_ACCESS_SECRET: "test-access-secret",
    JWT_REFRESH_SECRET: "test-refresh-secret",
    ACCESS_TOKEN_TTL_SECONDS: "900",
    REFRESH_TOKEN_TTL_SECONDS: "2592000"
  });
  const service = new SessionService(config);

  it("creates signed access and refresh tokens", async () => {
    const result = await service.createTokenPair({
      userId: "user-1",
      roles: ["SUPER_ADMIN", "USER"]
    });

    expect(result.accessToken).toMatch(/^eyJ/);
    expect(result.refreshToken).toMatch(/^eyJ/);
    expect(result.refreshTokenHash).toHaveLength(64);
    expect(result.refreshExpiresAt.getTime()).toBeGreaterThan(Date.now());
  });

  it("verifies access tokens", async () => {
    const result = await service.createTokenPair({
      userId: "user-2",
      roles: ["USER"],
      email: "person@example.com",
      name: "Person Example",
      authProvider: "google",
      avatarUrl: "https://example.com/avatar.png"
    });

    const payload = service.verifyAccessToken(result.accessToken);

    expect(payload.sub).toBe("user-2");
    expect(payload.roles).toEqual(["USER"]);
    expect(payload.email).toBe("person@example.com");
    expect(payload.authProvider).toBe("google");
  });

  it("verifies refresh tokens", async () => {
    const result = await service.createTokenPair({
      userId: "user-3",
      roles: ["USER"],
      email: "refresh@example.com",
      authProvider: "google"
    });

    const payload = service.verifyRefreshToken(result.refreshToken);

    expect(payload.sub).toBe("user-3");
    expect(payload.typ).toBe("refresh");
    expect(payload.email).toBe("refresh@example.com");
    expect(payload.roles).toEqual(["USER"]);
  });
});

describe("SessionService.createDbToken", () => {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const jwt = require("jsonwebtoken");

  it("signs an authenticated-role token for PostgREST with the user as sub", () => {
    const service = new SessionService(new ConfigService({ SUPABASE_JWT_SECRET: "db-secret-for-tests-0123456789abcdef" }));
    const issued = service.createDbToken("user-9");
    expect(issued).not.toBeNull();
    const payload = jwt.verify(issued!.token, "db-secret-for-tests-0123456789abcdef", { audience: "authenticated" });
    expect(payload.sub).toBe("user-9");
    expect(payload.role).toBe("authenticated");
    expect(payload.exp - payload.iat).toBe(900);
  });

  it("returns null when the database secret is not configured", () => {
    const service = new SessionService(new ConfigService({}));
    expect(service.createDbToken("user-9")).toBeNull();
  });
});
