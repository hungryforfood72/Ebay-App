// One-time setup, run once per environment AFTER connecting your eBay
// account in Settings with the sell.marketing scope granted (promoting an
// item needs an ad campaign to exist first — it's not created per item).
//
//   npx tsx scripts/ebay-setup-campaign.ts
//
// Prints the resulting campaign id — set it as EBAY_SANDBOX_AD_CAMPAIGN_ID
// or EBAY_PRODUCTION_AD_CAMPAIGN_ID (matching whichever EBAY_ENV this ran
// against) in .env.local and in Vercel's env vars.
import { config as loadEnv } from "dotenv";
loadEnv({ path: ".env.local" });

const DEFAULT_BID_PERCENTAGE = 5;

async function main() {
  // Dynamic import, not a static one — see ebay-setup-location.ts for why
  // (a static import hoists and evaluates DATABASE_URL before loadEnv runs).
  const { createAdCampaign, getAdCampaigns, getEbayEnvironment } = await import("../src/lib/ebay");

  const environment = getEbayEnvironment();
  console.log(`Checking for an existing ad campaign in the ${environment} environment...`);

  const existing = await getAdCampaigns();
  if (existing.length > 0) {
    console.log(`Already have one: ${existing[0].campaignId} ("${existing[0].campaignName}", ${existing[0].campaignStatus}).`);
    console.log("Nothing to do — reuse this id, don't create another.");
    return;
  }

  console.log(`Creating a new campaign (default bid ${DEFAULT_BID_PERCENTAGE}%, fallback only — you'll set the real bid per item when promoting)...`);
  const campaignId = await createAdCampaign(`Sticker Peak – ${environment}`, DEFAULT_BID_PERCENTAGE);
  console.log(`Done — campaign id: ${campaignId}`);
  console.log(
    `Set EBAY_${environment.toUpperCase()}_AD_CAMPAIGN_ID="${campaignId}" in .env.local and in Vercel's env vars.`
  );
}

main();
