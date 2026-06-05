import { CatalogController } from "./catalog.controller";
import { CatalogService } from "./catalog.service";

describe("CatalogController", () => {
  const service = new CatalogService();
  const controller = new CatalogController(service);

  it("returns active cleaning packages", async () => {
    const packages = await controller.listCleaningPackages();

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
