import { AdminController } from "./admin.controller";
import { CatalogService } from "../catalog/catalog.service";
import { AdminService } from "./admin.service";
import { NotificationsService } from "../notifications/notifications.service";
import { AdminRbacService } from "./admin-rbac.service";

describe("AdminController", () => {
  it("returns platform overview", () => {
    const controller = new AdminController(
      new CatalogService(),
      {} as AdminService,
      {} as AdminRbacService,
      {} as NotificationsService,
      {} as any,
      {} as any,
      {} as any
    );

    expect(controller.getOverview()).toEqual(
      expect.objectContaining({
        totalRevenueCents: 0
      })
    );
  });
});
