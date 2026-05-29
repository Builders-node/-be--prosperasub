import { AdminController } from "./admin.controller";
import { CatalogService } from "../catalog/catalog.service";
import { AdminService } from "./admin.service";
import { NotificationsService } from "../notifications/notifications.service";

describe("AdminController", () => {
  it("returns platform overview", () => {
    const controller = new AdminController(
      new CatalogService(),
      {} as AdminService,
      {} as NotificationsService,
      {} as any
    );

    expect(controller.getOverview()).toEqual(
      expect.objectContaining({
        restaurants: 4,
        activeRestaurants: 4,
        totalRevenueCents: 0
      })
    );
  });
});
