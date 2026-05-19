import { AdminController } from "./admin.controller";
import { CatalogService } from "../catalog/catalog.service";

describe("AdminController", () => {
  it("returns platform overview", () => {
    const controller = new AdminController(new CatalogService());

    expect(controller.getOverview()).toEqual(
      expect.objectContaining({
        restaurants: 4,
        activeRestaurants: 4,
        totalRevenueCents: 0
      })
    );
  });
});
