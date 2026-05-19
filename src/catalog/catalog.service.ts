import { Injectable } from "@nestjs/common";

export interface RestaurantDto {
  id: string;
  name: string;
  description: string;
  address: string;
  logoUrl: string | null;
  isActive: boolean;
}

export interface PlanDto {
  id: string;
  restaurantId: string;
  name: string;
  description: string;
  pricePerWeekCents: number;
  mealTime: string;
  menuCategory: string;
  supportsDelivery: boolean;
  restaurant: Pick<RestaurantDto, "id" | "name" | "logoUrl">;
}

export interface CleaningPackageDto {
  id: string;
  name: string;
  description: string;
  pricePerCleaningCents: number;
  cleaningsPerMonth: number;
  isActive: boolean;
}

@Injectable()
export class CatalogService {
  private readonly restaurants: RestaurantDto[] = [
    {
      id: "seed-restaurant-prospera-cafe",
      name: "Prospera Cafe",
      description: "Local weekly meal subscriptions for Prospera residents.",
      address: "Prospera Village",
      logoUrl: null,
      isActive: true
    },
    {
      id: "seed-restaurant-darien-kitchen",
      name: "Darien Kitchen",
      description: "Fresh lunch plans with delivery support.",
      address: "Roatan",
      logoUrl: null,
      isActive: true
    },
    {
      id: "seed-restaurant-lotos-grill",
      name: "Lotos Grill",
      description: "Fresh grilled weekly meal subscriptions for Prospera residents.",
      address: "Prospera Village",
      logoUrl: null,
      isActive: true
    },
    {
      id: "seed-restaurant-island-bistro",
      name: "Island Bistro",
      description: "Balanced local meal plans with fresh island ingredients.",
      address: "Prospera Village",
      logoUrl: null,
      isActive: true
    }
  ];

  private readonly plans: PlanDto[] = [
    {
      id: "seed-plan-weekly-lunch",
      restaurantId: "seed-restaurant-prospera-cafe",
      name: "Weekly Lunch",
      description: "Five lunches per week.",
      pricePerWeekCents: 7500,
      mealTime: "13:00:00",
      menuCategory: "STANDARD",
      supportsDelivery: true,
      restaurant: {
        id: "seed-restaurant-prospera-cafe",
        name: "Prospera Cafe",
        logoUrl: null
      }
    },
    {
      id: "seed-plan-vegetarian",
      restaurantId: "seed-restaurant-darien-kitchen",
      name: "Vegetarian Weekly",
      description: "Vegetarian lunch plan for weekdays.",
      pricePerWeekCents: 6800,
      mealTime: "12:30:00",
      menuCategory: "VEGETARIAN",
      supportsDelivery: true,
      restaurant: {
        id: "seed-restaurant-darien-kitchen",
        name: "Darien Kitchen",
        logoUrl: null
      }
    },
    {
      id: "seed-plan-lotos-grill",
      restaurantId: "seed-restaurant-lotos-grill",
      name: "Lotos Grill",
      description: "Fresh weekly meal plan from Lotos Grill.",
      pricePerWeekCents: 4800,
      mealTime: "12:00:00",
      menuCategory: "STANDARD",
      supportsDelivery: true,
      restaurant: {
        id: "seed-restaurant-lotos-grill",
        name: "Lotos Grill",
        logoUrl: null
      }
    },
    {
      id: "seed-plan-keto-weekly",
      restaurantId: "seed-restaurant-island-bistro",
      name: "Keto Weekly",
      description: "Low-carb weekly meal plan prepared by Island Bistro.",
      pricePerWeekCents: 6000,
      mealTime: "12:30:00",
      menuCategory: "KETO",
      supportsDelivery: true,
      restaurant: {
        id: "seed-restaurant-island-bistro",
        name: "Island Bistro",
        logoUrl: null
      }
    }
  ];

  private readonly cleaningPackages: CleaningPackageDto[] = [
    {
      id: "cleaning-1-bedroom-studio",
      name: "1 Bedroom & Studio",
      description: "1 cleaning per week for studios and one-bedroom homes.",
      pricePerCleaningCents: 1975,
      cleaningsPerMonth: 4,
      isActive: true
    },
    {
      id: "cleaning-2-bedroom",
      name: "2 Bedroom",
      description: "1 cleaning per week for two-bedroom homes.",
      pricePerCleaningCents: 2475,
      cleaningsPerMonth: 4,
      isActive: true
    }
  ];

  listRestaurants(): RestaurantDto[] {
    return this.restaurants.filter((restaurant) => restaurant.isActive);
  }

  getRestaurant(id: string): RestaurantDto | undefined {
    return this.restaurants.find((restaurant) => restaurant.id === id && restaurant.isActive);
  }

  listPlans(): PlanDto[] {
    return this.plans;
  }

  getPlan(id: string): PlanDto | undefined {
    return this.plans.find((plan) => plan.id === id);
  }

  listCleaningPackages(): CleaningPackageDto[] {
    return this.cleaningPackages.filter((pkg) => pkg.isActive);
  }

  getOverview() {
    return {
      users: 1,
      restaurants: this.restaurants.length,
      activeRestaurants: this.listRestaurants().length,
      activeSubscriptions: 0,
      pendingPayments: 0,
      totalRevenueCents: 0,
      cleaningActiveSubscriptions: 0,
      cleaningUpcomingBookings: 0,
      cleaningAvailableSlots: 0
    };
  }
}
