import { UnauthorizedException } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { AuthController } from "./auth.controller";
import { AuthService } from "./auth.service";
import { PasswordService } from "./password.service";
import { SessionService } from "./session.service";

describe("AuthController", () => {
  const service = new AuthService(
    new PasswordService(),
    new SessionService(new ConfigService()),
    new ConfigService()
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
