import { UnauthorizedException } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { AuthController } from "./auth.controller";
import { AuthService } from "./auth.service";
import { PasswordService } from "./password.service";
import { SessionService } from "./session.service";

describe("AuthController", () => {
  const mail = {
    sendPasswordResetEmail: jest.fn().mockResolvedValue({ sent: true })
  } as any;

  const service = new AuthService(
    new PasswordService(),
    new SessionService(new ConfigService()),
    new ConfigService(),
    mail
  );
  const controller = new AuthController(service);

  it("logs in the seeded Frorex account with the owned API password", async () => {
    const result = await controller.login({
      email: "frorex.studio@gmail.com",
      password: "111111"
    });

    expect(result.user.email).toBe("frorex.studio@gmail.com");
    expect(result.roles).toContain("super_admin");
    expect(result.session.access_token).toEqual(expect.any(String));
  });

  it("refreshes a valid session", async () => {
    const login = await controller.login({
      email: "frorex.studio@gmail.com",
      password: "111111"
    });

    const refreshed = await controller.refresh({
      refresh_token: login.session.refresh_token
    });

    expect(refreshed.user.email).toBe("frorex.studio@gmail.com");
    expect(refreshed.roles).toContain("super_admin");
    expect(refreshed.session.access_token).toEqual(expect.any(String));
    expect(refreshed.session.refresh_token).toEqual(expect.any(String));
  });

  it("creates a Google OAuth authorization URL", () => {
    const googleConfigValues: Record<string, string> = {
      GOOGLE_OAUTH_CLIENT_ID: "google-client-id",
      GOOGLE_OAUTH_CLIENT_SECRET: "google-client-secret",
      APP_ALLOWED_REDIRECT_ORIGINS: "",
    };
    const googleConfig = { get: jest.fn((key: string) => googleConfigValues[key]) } as any;
    const googleService = new AuthService(
      new PasswordService(),
      new SessionService(new ConfigService()),
      googleConfig,
      mail
    );
    const googleController = new AuthController(googleService);

    const result = googleController.startGoogleOAuth({
      redirectUrl: "http://localhost:8080/auth",
      state: "state-123"
    });
    const url = new URL(result.url);

    expect(url.origin).toBe("https://accounts.google.com");
    expect(url.searchParams.get("client_id")).toBe("google-client-id");
    expect(url.searchParams.get("redirect_uri")).toBe("http://localhost:8080/auth");
    expect(url.searchParams.get("state")).toBe("state-123");
    expect(url.searchParams.get("scope")).toBe("openid email profile");
  });

  it("rejects invalid refresh tokens", async () => {
    await expect(
      controller.refresh({
        refresh_token: "not-a-real-refresh-token"
      })
    ).rejects.toBeInstanceOf(UnauthorizedException);
  });

  it("rejects the previous shorter password", async () => {
    await expect(
      controller.login({
        email: "frorex.studio@gmail.com",
        password: "1111"
      })
    ).rejects.toBeInstanceOf(UnauthorizedException);
  });

  it("resets the Frorex password with a reset token", async () => {
    const reset = await controller.requestPasswordReset({
      email: "frorex.studio@gmail.com",
      redirectUrl: "http://localhost:8080/reset-password"
    });

    expect(reset.email).toBe("frorex.studio@gmail.com");
    expect(reset.resetToken).toEqual(expect.any(String));
    expect(reset.resetUrl).toContain("/reset-password?token=");
    expect(mail.sendPasswordResetEmail).toHaveBeenCalledWith({
      to: "frorex.studio@gmail.com",
      resetUrl: reset.resetUrl
    });

    await controller.confirmPasswordReset({
      token: reset.resetToken!,
      password: "222222"
    });

    await expect(
      controller.login({
        email: "frorex.studio@gmail.com",
        password: "111111"
      })
    ).rejects.toBeInstanceOf(UnauthorizedException);

    const login = await controller.login({
      email: "frorex.studio@gmail.com",
      password: "222222"
    });

    expect(login.roles).toContain("super_admin");
  });
});
