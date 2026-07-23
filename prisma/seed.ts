import { PrismaClient } from "@prisma/client";
import bcrypt from "bcryptjs";

const prisma = new PrismaClient();

async function main() {
  // EDGE-004 fix (Step 3): use upserts throughout so running `npm run seed` more than
  // once does not crash with a P2002 unique constraint violation. Previously, re-running
  // the seed failed immediately on the duplicate cuisine "Kenyan" with a raw Prisma
  // stack trace and no friendly guidance.

  // EDGE-003 fix (Step 3): give the demo user a known password so developers can
  // actually log in after seeding. Previously the user was created without a
  // passwordHash — any login attempt against vendor@foodypop.dev returned
  // 401 "Invalid credentials" with no explanation that the account had no password.
  const passwordHash = await bcrypt.hash("FoodyPop2026!", 10);

  const user = await prisma.user.upsert({
    where: { email: "vendor@foodypop.dev" },
    update: { passwordHash },
    create: {
      displayName: "Demo Vendor",
      email: "vendor@foodypop.dev",
      passwordHash,
      accountType: "VENDOR",
    },
  });

  const vendor = await prisma.vendor.upsert({
    where: { userId: user.id },
    update: {},
    create: {
      userId: user.id,
      name: "Mama Njeri's Kitchen",
      latitude: -1.2921,
      longitude: 36.8219,
      address: "Nairobi, Kenya",
    },
  });

  const kenyan = await prisma.cuisine.upsert({
    where: { name: "Kenyan" },
    update: {},
    create: { name: "Kenyan" },
  });

  const grill = await prisma.category.upsert({
    where: { name: "Grill" },
    update: {},
    create: { name: "Grill" },
  });

  // Dishes have no natural unique constraint, so guard against re-seeding by
  // only creating them when none exist for this vendor yet.
  const existingDishCount = await prisma.dish.count({ where: { vendorId: vendor.id } });
  if (existingDishCount === 0) {
    await prisma.dish.createMany({
      data: [
        {
          vendorId: vendor.id,
          name: "Nyama Choma",
          kind: "FOOD",
          description: "Charcoal-grilled beef, served with kachumbari",
          price: 450,
          cuisineId: kenyan.id,
          categoryId: grill.id,
          deliveryAvail: true,
        },
        {
          vendorId: vendor.id,
          name: "Ugali & Sukuma Wiki",
          kind: "FOOD",
          description: "Classic maize meal with sautéed greens",
          price: 150,
          cuisineId: kenyan.id,
          deliveryAvail: true,
        },
      ],
    });
    console.log("Seeded 2 dishes ✅");
  } else {
    console.log(`Dishes already present (${existingDishCount} found) — skipped ✅`);
  }

  console.log("Seed complete ✅");
  console.log("Demo login → email: vendor@foodypop.dev  |  password: FoodyPop2026!");
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
