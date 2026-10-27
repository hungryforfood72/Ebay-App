// Search tune-up for listings already live on eBay (Cristian, 2026-10-26):
// the recommended item specifics their category is missing
// (categorySpecifics.ts) and a title by the new title rules (draftItem.ts
// retitleItem). Proposes first, applies only what was proposed, so what
// goes live is exactly what was looked at.
//
//   npx tsx scripts/optimize-live-listings.ts generate [--limit 10]
//   npx tsx scripts/optimize-live-listings.ts report
//   npx tsx scripts/optimize-live-listings.ts apply [--limit 10]
//
// Proposals are kept in scratch-tmp/optimize-live-listings.json. generate
// skips listings already proposed; apply skips ones already applied, and
// any whose title was edited since the proposal. Bundles are left out.
import { config as loadEnv } from "dotenv";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
loadEnv({ path: ".env.local" });

const FILE = "scratch-tmp/optimize-live-listings.json";
const CONCURRENCY = 3;

type Proposal = {
  itemId: string;
  listingId: string;
  oldTitle: string;
  newTitle: string;
  addedSpecifics: Record<string, string>;
  generatedAt: string;
  appliedAt?: string;
  error?: string;
};

function load(): Proposal[] {
  return existsSync(FILE) ? (JSON.parse(readFileSync(FILE, "utf8")) as Proposal[]) : [];
}

function save(proposals: Proposal[]) {
  mkdirSync("scratch-tmp", { recursive: true });
  writeFileSync(FILE, JSON.stringify(proposals, null, 1));
}

function limitArg(): number {
  const i = process.argv.indexOf("--limit");
  return i >= 0 ? Number(process.argv[i + 1]) : Infinity;
}

async function inBatches<T>(list: T[], run: (t: T) => Promise<void>) {
  for (let i = 0; i < list.length; i += CONCURRENCY) await Promise.all(list.slice(i, i + CONCURRENCY).map(run));
}

async function generate() {
  const { prisma } = await import("../src/lib/prisma");
  const { fillCategorySpecifics } = await import("../src/lib/categorySpecifics");
  const { retitleItem } = await import("../src/lib/draftItem");
  const proposals = load();
  const done = new Set(proposals.map((p) => p.itemId));
  const items = (
    await prisma.item.findMany({
      where: {
        status: "listed",
        ebayEnvironment: "production",
        ebayListingId: { not: null },
        ebayOfferId: { not: null },
        categoryId: { not: null },
        isBundle: false,
      },
      orderBy: { ebayPublishedAt: "desc" },
    })
  )
    .filter((i) => !done.has(i.id))
    .slice(0, limitArg());
  console.log(`Proposing changes for ${items.length} listings...`);
  await inBatches(items, async (item) => {
    try {
      const addedSpecifics = await fillCategorySpecifics(item.id, { save: false });
      const newTitle = await retitleItem(item, addedSpecifics);
      proposals.push({
        itemId: item.id,
        listingId: item.ebayListingId!,
        oldTitle: item.finalTitle ?? "",
        newTitle,
        addedSpecifics,
        generatedAt: new Date().toISOString(),
      });
      save(proposals);
      console.log(`  ${item.ebayListingId}: ${Object.keys(addedSpecifics).length} specifics, title ${newTitle === item.finalTitle ? "unchanged" : "changed"}`);
    } catch (e) {
      console.error(`  ${item.ebayListingId}: failed`, e instanceof Error ? e.message : e);
    }
  });
}

function report() {
  for (const p of load()) {
    console.log(`\n${p.listingId}${p.appliedAt ? " (applied)" : ""}${p.error ? ` (error: ${p.error})` : ""}`);
    if (p.newTitle !== p.oldTitle) {
      console.log(`  old (${p.oldTitle.length}): ${p.oldTitle}`);
      console.log(`  new (${p.newTitle.length}): ${p.newTitle}`);
    } else console.log(`  title unchanged: ${p.oldTitle}`);
    for (const [name, value] of Object.entries(p.addedSpecifics)) console.log(`  + ${name}: ${value}`);
  }
}

async function apply() {
  const { prisma } = await import("../src/lib/prisma");
  const { buildAspects, toEbaySku, updateLiveTitleAndAspects, ebayAspectNameToSpecificsKey } = await import("../src/lib/ebay");
  const { logActivity } = await import("../src/lib/activityLog");
  const proposals = load();
  const todo = proposals.filter((p) => !p.appliedAt).slice(0, limitArg());
  console.log(`Applying ${todo.length} proposals...`);
  for (const p of todo) {
    const item = await prisma.item.findUnique({ where: { id: p.itemId } });
    if (!item || item.status !== "listed" || !item.ebayListingId) {
      p.error = "no longer live";
    } else if ((item.finalTitle ?? "") !== p.oldTitle) {
      p.error = "title edited since the proposal";
    } else {
      const current = (item.itemSpecifics as Record<string, string> | null) ?? {};
      const additions = Object.fromEntries(
        Object.entries(p.addedSpecifics).map(([name, value]) => [ebayAspectNameToSpecificsKey(name), value])
      );
      const specifics = { ...additions, ...current };
      try {
        await updateLiveTitleAndAspects(item.ebaySku ?? toEbaySku(item.sku), p.newTitle, buildAspects(specifics, item.expirationDate));
        await prisma.item.update({
          where: { id: item.id },
          data: {
            finalTitle: p.newTitle,
            // Still counts as an unedited draft if it was one.
            ...(item.aiTitle === item.finalTitle ? { aiTitle: p.newTitle } : {}),
            itemSpecifics: specifics,
          },
        });
        await logActivity(
          { username: "optimize-live-listings" },
          {
            action: "item.search_tuneup",
            summary: `Search tune-up on live listing ${p.listingId}: ${Object.keys(p.addedSpecifics).length} specifics added${p.newTitle !== p.oldTitle ? ", new title" : ""}`,
            targetType: "item",
            targetId: item.id,
            before: { finalTitle: p.oldTitle, itemSpecifics: current },
            after: { finalTitle: p.newTitle, itemSpecifics: specifics },
            method: "SCRIPT",
            path: "scripts/optimize-live-listings.ts",
          }
        );
        p.appliedAt = new Date().toISOString();
        delete p.error;
        console.log(`  ${p.listingId}: done`);
      } catch (e) {
        p.error = e instanceof Error ? e.message.slice(0, 300) : String(e);
      }
    }
    if (p.error) console.log(`  ${p.listingId}: skipped (${p.error})`);
    save(proposals);
  }
}

const command = process.argv[2];
const run = command === "generate" ? generate : command === "apply" ? apply : command === "report" ? async () => report() : null;
if (!run) {
  console.error("Usage: npx tsx scripts/optimize-live-listings.ts generate|report|apply [--limit N]");
  process.exit(1);
}
run().then(() => process.exit(0), (e) => { console.error(e); process.exit(1); });
