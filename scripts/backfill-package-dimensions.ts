// Live listings went up with only a weight, so eBay's label page showed
// 1x1x1 for the box (fixed in putInventoryItem 2026-11-03). This sends each
// live listing its box's dimensions and changes nothing else on it.
//
//   npx tsx scripts/backfill-package-dimensions.ts            (dry run)
//   npx tsx scripts/backfill-package-dimensions.ts --apply [--limit 5] [--skus A,B]
import { config as loadEnv } from "dotenv";
loadEnv({ path: ".env.local" });

const CONCURRENCY = 3;

function limitArg(): number {
  const i = process.argv.indexOf("--limit");
  return i >= 0 ? Number(process.argv[i + 1]) : Infinity;
}

async function main() {
  const apply = process.argv.includes("--apply");
  const { prisma } = await import("../src/lib/prisma");
  const { toEbaySku, updateLivePackageDimensions } = await import("../src/lib/ebay");

  const skusAt = process.argv.indexOf("--skus");
  const skus = skusAt >= 0 ? process.argv[skusAt + 1].split(",") : null;
  const items = (
    await prisma.item.findMany({
      where: {
        ...(skus ? { sku: { in: skus } } : {}),
        status: "listed",
        ebayEnvironment: "production",
        ebayListingId: { not: null },
        boxSize: { not: null },
        localPickupOnly: false,
      },
      select: { sku: true, ebaySku: true, boxSize: true },
      orderBy: { ebayPublishedAt: "desc" },
    })
  ).slice(0, limitArg());

  const byBox = new Map<string, number>();
  for (const i of items) byBox.set(i.boxSize!, (byBox.get(i.boxSize!) ?? 0) + 1);
  console.log(`${items.length} live listings with a box:`, Object.fromEntries(byBox));
  if (!apply) {
    console.log("Dry run. Add --apply to send the dimensions to eBay.");
    return;
  }

  let done = 0;
  let skipped = 0;
  const failed: string[] = [];
  for (let i = 0; i < items.length; i += CONCURRENCY) {
    await Promise.all(
      items.slice(i, i + CONCURRENCY).map(async (item) => {
        try {
          const ok = await updateLivePackageDimensions(item.ebaySku ?? toEbaySku(item.sku), item.boxSize);
          if (ok) done++;
          else skipped++;
        } catch (e) {
          failed.push(`${item.sku}: ${e instanceof Error ? e.message : String(e)}`);
        }
      })
    );
    process.stdout.write(`\r${done} updated, ${skipped} skipped, ${failed.length} failed`);
  }
  console.log();
  for (const f of failed) console.log(f);
}

main().then(() => process.exit(0), (e) => { console.error(e); process.exit(1); });
