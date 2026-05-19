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
      roles: ["USER"]
    });

    const payload = service.verifyAccessToken(result.accessToken);

    expect(payload.sub).toBe("user-2");
    expect(payload.roles).toEqual(["USER"]);
  });
});
