import { PasswordService } from "./password.service";

describe("PasswordService", () => {
  const service = new PasswordService();

  it("hashes and verifies a password", async () => {
    const hash = await service.hash("ProsperaSub123!");

    expect(hash).not.toBe("ProsperaSub123!");
    await expect(service.verify("ProsperaSub123!", hash)).resolves.toBe(true);
    await expect(service.verify("wrong-password", hash)).resolves.toBe(false);
  });
});
