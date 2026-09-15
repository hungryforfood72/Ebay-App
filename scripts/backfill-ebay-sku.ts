// One-off backfill — sets Item.ebaySku on every already-published item that
// predates the field, so order sync can match them. Safe to re-run
// (idempotent — only touches rows where ebaySku is still null).
//
//   npx tsx scripts/backfill-ebay-sku.ts
//
import { config as loadEnv } from "dotenv";
loadEnv({ path: ".env.local" });

async function main() {
  const { PrismaClient } = await import("../src/generated/prisma/client");
  const { PrismaPg } = await import("@prisma/adapter-pg");
  const { toEbaySku } = await import("../src/lib/ebay");

  const adapter = new PrismaPg({ connectionString: process.env.DATABASE_URL });
  const prisma = new PrismaClient({ adapter });

  const items = await prisma.item.findMany({
    where: { status: { in: ["listed", "sold"] }, ebaySku: null },
    select: { id: true, sku: true },
  });
  console.log(`${items.length} item(s) missing ebaySku.`);

  for (const item of items) {
    const ebaySku = toEbaySku(item.sku);
    await prisma.item.update({ where: { id: item.id }, data: { ebaySku } });
    console.log(`${item.sku} -> ${ebaySku}`);
  }

  console.log("Done.");
  await prisma.$disconnect();
}

main();
