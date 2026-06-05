import { PrismaClient, type app_role } from "@prisma/client";
import * as bcrypt from "bcryptjs";

const prisma = new PrismaClient();

async function ensureUserRoles(userId: string, roles: app_role[]) {
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
      authProvider: "email",
      profile: {
        create: {
          phone: "+50400000000"
        }
      }
    }
  });

  await ensureUserRoles(admin.id, ["super_admin", "user"]);

  await prisma.user.upsert({
    where: { email: "frorex.studio@gmail.com" },
    update: {
      passwordHash: frorexPasswordHash,
      name: "Frorex Studio",
      displayName: "Frorex",
      authProvider: "email"
    },
    create: {
      email: "frorex.studio@gmail.com",
      passwordHash: frorexPasswordHash,
      name: "Frorex Studio",
      displayName: "Frorex",
      authProvider: "email",
      profile: {
        create: {}
      }
    }
  }).then((user) => ensureUserRoles(user.id, ["super_admin", "user"]));

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
        paymentStatus: "pending"
      }
    },
    create: {
      key: "platform",
      value: {
        name: "Prospera Sub",
        paymentStatus: "pending"
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
