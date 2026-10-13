// Creates InPersonSale rows for shelf/walk-up sales recorded before that
// table existed. Those sales only left a StockAdjustment behind, whose note
// carries the quantity and price ("Shelf sale — 1 unit(s) @ $10.00 each, in
// person"). Failed attempts ("[FAILED: ...]") never changed stock and are
// skipped. Safe to re-run: stockAdjustmentId is unique, so a sale already
// recorded is left alone.
//
//   npx tsx scripts/backfill-in-person-sales.ts          (dry run)
//   npx tsx scripts/backfill-in-person-sales.ts --apply
//
import { config as loadEnv } from "dotenv";
loadEnv({ path: ".env.local" });

const NOTE = /^(?:Shelf sale|Walk-up sale) — (\d+) unit\(s\) @ \$([\d.]+) each, in person$/;

async function main() {
  const apply = process.argv.includes("--apply");
  const { PrismaClient } = await import("../src/generated/prisma/client");
  const { PrismaPg } = await import("@prisma/adapter-pg");
  const prisma = new PrismaClient({ adapter: new PrismaPg({ connectionString: process.env.DATABASE_URL }) });

  const adjustments = await prisma.stockAdjustment.findMany({
    where: { OR: [{ note: { startsWith: "Shelf sale" } }, { note: { startsWith: "Walk-up sale" } }] },
    orderBy: { createdAt: "asc" },
    include: { item: { select: { finalTitle: true } } },
  });
  const existing = new Set(
    (await prisma.inPersonSale.findMany({ select: { stockAdjustmentId: true } })).map((s) => s.stockAdjustmentId)
  );

  let created = 0;
  for (const a of adjustments) {
    const match = NOTE.exec(a.note);
    if (!match) {
      console.log(`skip (${a.note.includes("[FAILED") ? "failed attempt" : "unrecognized note"}): ${a.note}`);
      continue;
    }
    if (existing.has(a.id)) continue;
    const quantity = Number(match[1]);
    const pricePerUnit = Number(match[2]);
    if (quantity !== -a.delta) {
      console.log(`skip (note says ${quantity}, stock moved ${-a.delta}): ${a.note}`);
      continue;
    }
    console.log(`${a.createdAt.toISOString()}  ${quantity} x $${pricePerUnit.toFixed(2)}  ${a.item.finalTitle ?? a.itemId}`);
    if (apply) {
      await prisma.inPersonSale.create({
        data: {
          itemId: a.itemId,
          quantity,
          pricePerUnit,
          revenue: quantity * pricePerUnit,
          recordedBy: a.recordedBy,
          stockAdjustmentId: a.id,
          soldAt: a.createdAt,
        },
      });
    }
    created++;
  }
  console.log(`${apply ? "Created" : "Would create"} ${created} in-person sale(s).`);
  await prisma.$disconnect();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
