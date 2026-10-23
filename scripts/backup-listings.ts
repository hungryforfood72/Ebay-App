// Runs the eBay listing backup (src/lib/listingBackup.ts) from this PC,
// with no time limit. Handy for the first fill; the hourly cron keeps it
// current after that.
//   npx tsx scripts/backup-listings.ts
import { config as loadEnv } from "dotenv";
loadEnv({ path: ".env.local", quiet: true });

async function main() {
  const { runListingBackup, getBackupSummary } = await import("../src/lib/listingBackup");
  const { prisma } = await import("../src/lib/prisma");
  console.log(await runListingBackup({ budgetMs: 60 * 60 * 1000 }));
  console.log(JSON.stringify((await getBackupSummary()).accounts, null, 2));
  await prisma.$disconnect();
}
main();
