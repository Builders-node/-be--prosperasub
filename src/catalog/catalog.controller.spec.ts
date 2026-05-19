import { CatalogController } from "./catalog.controller";
import { CatalogService } from "./catalog.service";

describe("CatalogController", () => {
  const service = new CatalogService();
  const controller = new CatalogController(service);

  it("returns active restaurants", () => {
    const restaurants = controller.listRestaurants();

    expect(restaurants.length).toBeGreaterThan(0);
    expect(restaurants[0]).toHaveProperty("name");
  });

  it("returns active plans", () => {
    const plans = controller.listPlans();

    expect(plans.length).toBeGreaterThan(0);
    expect(plans[0]).toHaveProperty("pricePerWeekCents");
  });

  it("returns active cleaning packages", () => {
    const packages = controller.listCleaningPackages();

    expect(packages).toEqual(expect.arrayContaining([
      expect.objectContaining({
        id: "cleaning-1-bedroom-studio",
        pricePerCleaningCents: 1975
      }),
      expect.objectContaining({
        id: "cleaning-2-bedroom",
        pricePerCleaningCents: 2475
      })
    ]));
  });
});
