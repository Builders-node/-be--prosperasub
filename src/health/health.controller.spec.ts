import { HealthController } from "./health.controller";

describe("HealthController", () => {
  it("reports the API up and the database absent when Prisma was never injected", () => {
    // Prisma is @Optional() so the health check still answers on a deployment
    // where the database connection failed — that is the case worth asserting.
    expect(new HealthController().getHealth()).toEqual({
      status: "ok",
      service: "prospera-sub-api",
      database: "unavailable",
      dbError: null,
    });
  });

  it("reports the database connected, and surfaces a connect error when there is one", () => {
    const withDb = new HealthController({ isAvailable: () => true, getConnectError: () => null } as any);
    expect(withDb.getHealth()).toMatchObject({ database: "connected", dbError: null });

    const broken = new HealthController({
      isAvailable: () => false,
      getConnectError: () => "P1001: can't reach database server",
    } as any);
    expect(broken.getHealth()).toMatchObject({
      database: "unavailable",
      dbError: "P1001: can't reach database server",
    });
  });
});
