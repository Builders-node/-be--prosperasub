import { PrismaClient, UserRoleName, AuthProvider, MenuCategory, PaymentStatus } from "@prisma/client";
import * as bcrypt from "bcryptjs";

const prisma = new PrismaClient();

async function ensureUserRoles(userId: string, roles: UserRoleName[]) {
  await prisma.userRole.createMany({
    data: roles.map((role) => ({ userId, role })),
    skipDuplicates: true
  });
}

async function main() {
  const adminPasswordHash = await bcrypt.hash("ProsperaSub123!", 12);
  const frorexPasswordHash = await bcrypt.hash("111111", 12);

  const admin = await prisma.user.upsert({
    where: { email: "admin@prosperasub.local" },
    update: {},
    create: {
      email: "admin@prosperasub.local",
      passwordHash: adminPasswordHash,
      name: "Prospera Sub Admin",
      displayName: "Admin",
      authProvider: AuthProvider.EMAIL,
      profile: {
        create: {
          phone: "+50400000000",
          defaultDeliveryAddress: {
            address: "Prospera",
            city: "Roatan",
            country: "Honduras"
          }
        }
      }
    }
  });

  await ensureUserRoles(admin.id, [UserRoleName.SUPER_ADMIN, UserRoleName.USER]);

  await prisma.user.upsert({
    where: { email: "frorex.studio@gmail.com" },
    update: {
      passwordHash: frorexPasswordHash,
      name: "Frorex Studio",
      displayName: "Frorex",
      authProvider: AuthProvider.EMAIL
    },
    create: {
      email: "frorex.studio@gmail.com",
      passwordHash: frorexPasswordHash,
      name: "Frorex Studio",
      displayName: "Frorex",
      authProvider: AuthProvider.EMAIL,
      profile: {
        create: {
          defaultDeliveryAddress: {
            address: "Prospera Village",
            city: "Roatan",
            country: "Honduras"
          }
        }
      }
    }
  }).then((user) => ensureUserRoles(user.id, [UserRoleName.SUPER_ADMIN, UserRoleName.USER]));

  const restaurant = await prisma.restaurant.upsert({
    where: { id: "seed-restaurant-prospera-cafe" },
    update: {},
    create: {
      id: "seed-restaurant-prospera-cafe",
      name: "Prospera Cafe",
      description: "Seed restaurant for local meal subscriptions.",
      address: "Prospera Village",
      isActive: true,
      createdById: admin.id,
      admins: {
        create: {
          userId: admin.id,
          isOwner: true
        }
      },
      settings: {
        create: {
          cutoffHour: 18,
          deliveryFeeCents: 300
        }
      }
    }
  });

  await prisma.subscriptionPlan.upsert({
    where: { id: "seed-plan-weekly-lunch" },
    update: {},
    create: {
      id: "seed-plan-weekly-lunch",
      restaurantId: restaurant.id,
      name: "Weekly Lunch",
      description: "Five lunches per week.",
      pricePerWeekCents: 7500,
      mealTime: "13:00:00",
      menuCategory: MenuCategory.STANDARD,
      supportsDelivery: true,
      isActive: true
    }
  });

  await prisma.cleaningPackage.upsert({
    where: { id: "cleaning-1-bedroom-studio" },
    update: {
      name: "1 Bedroom & Studio",
      description: "1 cleaning per week for studios and one-bedroom homes.",
      pricePerCleaningCents: 1975,
      cleaningsPerMonth: 4,
      isActive: true
    },
    create: {
      id: "cleaning-1-bedroom-studio",
      name: "1 Bedroom & Studio",
      description: "1 cleaning per week for studios and one-bedroom homes.",
      pricePerCleaningCents: 1975,
      cleaningsPerMonth: 4,
      isActive: true
    }
  });

  await prisma.cleaningPackage.upsert({
    where: { id: "cleaning-2-bedroom" },
    update: {
      name: "2 Bedroom",
      description: "1 cleaning per week for two-bedroom homes.",
      pricePerCleaningCents: 2475,
      cleaningsPerMonth: 4,
      isActive: true
    },
    create: {
      id: "cleaning-2-bedroom",
      name: "2 Bedroom",
      description: "1 cleaning per week for two-bedroom homes.",
      pricePerCleaningCents: 2475,
      cleaningsPerMonth: 4,
      isActive: true
    }
  });

  await prisma.globalSetting.upsert({
    where: { key: "platform" },
    update: {
      value: {
        name: "Prospera Sub",
        paymentStatus: PaymentStatus.PENDING
      }
    },
    create: {
      key: "platform",
      value: {
        name: "Prospera Sub",
        paymentStatus: PaymentStatus.PENDING
      }
    }
  });
}

main()
  .then(async () => {
    await prisma.$disconnect();
  })
  .catch(async (error) => {
    console.error(error);
    await prisma.$disconnect();
    process.exit(1);
  });
