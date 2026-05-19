import { HealthController } from "./health.controller";

describe("HealthController", () => {
  it("returns API health status", async () => {
    const controller = new HealthController();

    expect(controller.getHealth()).toEqual({
      status: "ok",
      service: "prospera-sub-api"
    });
  });
});
