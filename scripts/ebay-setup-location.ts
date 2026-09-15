// One-time setup, run once per environment AFTER connecting your eBay
// account in Settings (createOffer needs a merchantLocationKey to already
// exist — it's a ship-from location, not something created per listing).
//
//   npx tsx scripts/ebay-setup-location.ts
//
import { config as loadEnv } from "dotenv";
loadEnv({ path: ".env.local" });

async function main() {
  // Dynamic import, not a static one — static imports are hoisted and would
  // evaluate src/lib/prisma.ts's `new PrismaPg({ connectionString:
  // process.env.DATABASE_URL })` before loadEnv() above ever runs, leaving
  // DATABASE_URL empty and every query failing with ECONNREFUSED.
  const { createOrUpdateMerchantLocation, EbayApiError, getEbayEnvironment } = await import("../src/lib/ebay");

  const zip = process.env.EBAY_LISTING_ZIP;
  if (!zip) {
    console.error("Set EBAY_LISTING_ZIP in .env.local first.");
    process.exit(1);
  }
  console.log(`Creating merchant location for the ${getEbayEnvironment()} environment, ZIP ${zip}...`);
  try {
    await createOrUpdateMerchantLocation(zip);
    console.log("Done — merchant location is ready.");
  } catch (e) {
    if (e instanceof EbayApiError && e.status === 409) {
      console.log("Already exists — nothing to do.");
      return;
    }
    console.error("Failed:", e instanceof Error ? e.message : e);
    process.exit(1);
  }
}

main();
