import { Controller, Get, NotFoundException, Param } from "@nestjs/common";
import { ApiOperation, ApiParam, ApiResponse, ApiTags } from "@nestjs/swagger";
import { CatalogService } from "./catalog.service";

@ApiTags("Catalog")
@Controller()
export class CatalogController {
  constructor(private readonly catalog: CatalogService) {}

  @ApiOperation({ summary: "List active restaurants" })
  @ApiResponse({ status: 200, description: "Active restaurants." })
  @Get("restaurants")
  listRestaurants() {
    return this.catalog.listRestaurants();
  }

  @ApiOperation({ summary: "Get one active restaurant" })
  @ApiParam({ name: "id", example: "seed-restaurant-lotos-grill" })
  @ApiResponse({ status: 200, description: "Restaurant details." })
  @ApiResponse({ status: 404, description: "Restaurant not found." })
  @Get("restaurants/:id")
  getRestaurant(@Param("id") id: string) {
    const restaurant = this.catalog.getRestaurant(id);

    if (!restaurant) {
      throw new NotFoundException("Restaurant not found");
    }

    return restaurant;
  }

  @ApiOperation({ summary: "List subscription meal plans" })
  @ApiResponse({ status: 200, description: "Subscription meal plans." })
  @Get("plans")
  listPlans() {
    return this.catalog.listPlans();
  }

  @ApiOperation({ summary: "Get one subscription meal plan" })
  @ApiParam({ name: "id", example: "seed-plan-lotos-grill" })
  @ApiResponse({ status: 200, description: "Plan details." })
  @ApiResponse({ status: 404, description: "Plan not found." })
  @Get("plans/:id")
  getPlan(@Param("id") id: string) {
    const plan = this.catalog.getPlan(id);

    if (!plan) {
      throw new NotFoundException("Plan not found");
    }

    return plan;
  }

  @ApiOperation({ summary: "List active cleaning packages" })
  @ApiResponse({ status: 200, description: "Active cleaning packages." })
  @Get("cleaning/packages")
  listCleaningPackages() {
    return this.catalog.listCleaningPackages();
  }
}
