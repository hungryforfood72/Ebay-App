import type { Item } from "@/generated/prisma/client";
import { cogsMapsFor, costPerListingUnit } from "./cogs";
import { prisma } from "./prisma";
import { retailPrices } from "./shopifySync";
import { WHATNOT_CSV_CATEGORIES, WHATNOT_HAZMAT, WHATNOT_SHIPPING_PROFILES } from "./whatnotCsvValues";
import { categoryFor, categoryPathOf, description, getCategoryMap, packageWeightOz, whatnotProblem } from "./whatnotSync";

// Whatnot giveaways (Cristian, 2026-11-07). Coupon codes got hard to manage
// and buyers stopped liking them, so giveaways are real items now: small,
// light stock listed in Giveaway mode on the List page (Item.whatnotGiveaway),
// kept in giveaway bins, and put on a show with Whatnot's bulk-upload CSV,
// which this file fills in (Whatnot's API can't make a giveaway listing).
// A win arrives as a Whatnot order with transaction_type "giveaway" and is
// recorded here as a giveaway cost, never as a sale: nothing that learns
// from sales (the Analyzer, sell-speed predictions) should see a $0 sale.

// ---------------------------------------------------------------------------
// A giveaway won
// ---------------------------------------------------------------------------

// Takes the unit(s) out of stock (or puts them back, cancelled). The order
// item id makes it safe to call again for the same order. Returns whether
// anything changed.
export async function recordGiveaway(args: {
  itemId: string;
  orderId: string;
  orderItemId: string;
  quantity: number;
  givenAt: Date;
  showId: string | null;
  cancelled: boolean;
}): Promise<boolean> {
  const existing = await prisma.whatnotGiveaway.findUnique({ where: { orderItemId: args.orderItemId } });
  if (args.cancelled) {
    if (!existing || existing.cancelledAt) return false;
    return await prisma.$transaction(async (tx) => {
      // Only the first of two cancel deliveries does it.
      const claim = await tx.whatnotGiveaway.updateMany({ where: { id: existing.id, cancelledAt: null }, data: { cancelledAt: new Date() } });
      if (claim.count === 0) return false;
      const item = await tx.item.findUniqueOrThrow({ where: { id: existing.itemId } });
      const sold = Math.max(0, item.soldQuantity - existing.quantity);
      await tx.item.update({
        where: { id: item.id },
        data: {
          soldQuantity: sold,
          status: item.status === "sold" && sold < item.quantity ? "listed" : undefined,
          // Whatnot put it back on its own count (an API-made listing).
          ...(item.whatnotQuantity != null ? { whatnotQuantity: { increment: existing.quantity } } : {}),
        },
      });
      return true;
    });
  }
  if (existing) return false;
  try {
    return await prisma.$transaction(async (tx) => {
      const item = await tx.item.findUnique({ where: { id: args.itemId } });
      if (!item) return false;
      await tx.whatnotGiveaway.create({
        data: {
          itemId: item.id,
          orderId: args.orderId,
          orderItemId: args.orderItemId,
          showId: args.showId,
          quantity: args.quantity,
          givenAt: args.givenAt,
        },
      });
      const sold = item.soldQuantity + args.quantity;
      await tx.item.update({
        where: { id: item.id },
        data: {
          soldQuantity: { increment: args.quantity },
          status: sold >= item.quantity ? "sold" : undefined,
          // Whatnot already took it off its own count.
          ...(item.whatnotQuantity != null ? { whatnotQuantity: { decrement: args.quantity } } : {}),
        },
      });
      return true;
    });
  } catch (e) {
    // Another delivery of the same order recorded it first.
    if ((e as { code?: string }).code === "P2002") return false;
    throw e;
  }
}

// What the giveaways given in [from, to) cost: each unit's share of its
// load's cost, like COGS on a sale. Cancelled ones don't count.
export async function giveawayCost(from: Date | null, to: Date | null): Promise<{ units: number; cost: number }> {
  const range = from || to ? { ...(from ? { gte: from } : {}), ...(to ? { lt: to } : {}) } : undefined;
  const rows = await prisma.whatnotGiveaway.findMany({
    where: { givenAt: range, cancelledAt: null },
    select: {
      quantity: true,
      item: { select: { manifestId: true, upc: true, isMultipack: true, packSize: true, isBundle: true, bundleComponents: true } },
    },
  });
  if (rows.length === 0) return { units: 0, cost: 0 };
  const maps = await cogsMapsFor(rows.map((r) => r.item.manifestId));
  let units = 0;
  let cost = 0;
  for (const r of rows) {
    units += r.quantity;
    cost += costPerListingUnit(r.item, maps).cost * r.quantity;
  }
  return { units, cost };
}

// ---------------------------------------------------------------------------
// The giveaway CSV
// ---------------------------------------------------------------------------

// Whatnot asks whether each listing is a hazardous material (its help
// article "Hazardous Materials and Flammable Substances": lithium
// batteries, aerosols, fragrances, glues, hand sanitizer, lighters, nail
// polish, paint). Plain word rules, no AI (Cristian: no API credits on
// Whatnot checks). Anything Whatnot bans outright is already stopped by
// whatnotPolicy.ts at listing.
const LITHIUM = /\b(lithium|li-?ion|rechargeable|power ?bank|battery[- ]powered|bluetooth|wireless (earbuds|headphones|speaker)|smart ?watch)\b/i;
const HAZMAT = /\b(aerosol|spray ?can|dry shampoo|hair ?spray|spray paint|perfume|cologne|eau de (toilette|parfum)|body mist|fragrance mist|nail (polish|lacquer|enamel)|nail polish remover|super ?glue|glue|adhesive|hand sanitizer|sanitizing gel|lighter|butane|paint|acetone)\b/i;

export function whatnotHazmat(title: string, categoryPath: string | null): string {
  const text = `${title} ${categoryPath ?? ""}`;
  if (LITHIUM.test(text)) return WHATNOT_HAZMAT.lithium;
  if (HAZMAT.test(text)) return WHATNOT_HAZMAT.standard;
  return WHATNOT_HAZMAT.none;
}

// The lightest profile the item's packed weight fits (the listing
// station's scale reading). Heavier than the heaviest = the heaviest.
export function shippingProfileFor(weightOz: number): string {
  const hit = WHATNOT_SHIPPING_PROFILES.find(([, top]) => weightOz <= top);
  return (hit ?? WHATNOT_SHIPPING_PROFILES[WHATNOT_SHIPPING_PROFILES.length - 1])[0];
}

// One CSV field. Quoted when it has to be; a leading = + - @ is dropped so
// opening the file in Excel or Sheets can't run it as a formula.
function field(value: string | number | null | undefined): string {
  let s = value == null ? "" : String(value);
  s = s.replace(/[\r\n]+/g, " ").replace(/\s{2,}/g, " ");
  // Spaces and formula characters together: "= =HYPERLINK(" must not
  // come out as "=HYPERLINK(" (security review, 2026-11-07).
  s = s.replace(/^[\s=+\-@]+/, "").trim();
  return /[",]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

const HEADER = [
  "Category",
  "Sub Category",
  "Title",
  "Description",
  "Quantity",
  "Type",
  "Price",
  "Shipping Profile",
  "Offerable",
  "Hazmat",
  "Condition",
  "Cost Per Item",
  "SKU",
  ...Array.from({ length: 8 }, (_, i) => `Image URL ${i + 1}`),
];

// Deal Hunting (Estate Sales & Storage Units), the category map's own
// default, when the map has nothing for an item.
const FALLBACK_CATEGORY = 265;

export type GiveawayCsvRow = { sku: string; title: string; quantity: number };
export type GiveawayCsvSkip = { sku: string; title: string; reason: string };

export async function buildGiveawayCsv(binCodes: string[]): Promise<{
  csv: string;
  rows: GiveawayCsvRow[];
  skipped: GiveawayCsvSkip[];
  itemIds: string[];
  binCodes: string[];
}> {
  const codes = [...new Set(binCodes.map((c) => c.trim().toUpperCase()).filter(Boolean))].slice(0, 50);
  const bins = await prisma.bin.findMany({
    where: { code: { in: codes } },
    select: { code: true, giveaway: true, contents: { select: { units: true, itemId: true } } },
  });
  const notGiveaway = bins.filter((b) => !b.giveaway).map((b) => b.code);
  if (notGiveaway.length) throw new Error(`${notGiveaway.join(", ")} ${notGiveaway.length === 1 ? "isn't a giveaway bin" : "aren't giveaway bins"}.`);
  const missing = codes.filter((c) => !bins.some((b) => b.code === c));
  if (missing.length) throw new Error(`No bin ${missing.join(", ")}.`);

  // Units of each item across the picked bins.
  const unitsByItem = new Map<string, number>();
  for (const b of bins) for (const c of b.contents) unitsByItem.set(c.itemId, (unitsByItem.get(c.itemId) ?? 0) + c.units);
  const items = await prisma.item.findMany({ where: { id: { in: [...unitsByItem.keys()] } }, orderBy: { sku: "asc" } });
  const [map, retail, maps] = await Promise.all([getCategoryMap(), retailPrices(items), cogsMapsFor(items.map((i) => i.manifestId))]);

  const lines = [HEADER.map(field).join(",")];
  const rows: GiveawayCsvRow[] = [];
  const skipped: GiveawayCsvSkip[] = [];
  for (const item of items) {
    const title = (item.finalTitle ?? item.aiTitle ?? "").trim();
    const skip = (reason: string) => skipped.push({ sku: item.sku, title: title || item.sku, reason });
    if (!item.whatnotGiveaway) {
      skip("Not a giveaway item. Move it out of the giveaway bin.");
      continue;
    }
    const left = item.quantity - item.soldQuantity;
    const quantity = Math.min(unitsByItem.get(item.id) ?? 0, left);
    if (quantity <= 0) {
      skip("None left: given away already.");
      continue;
    }
    if (!title) {
      skip("No title yet. Open it on Review (the AI draft may still be running).");
      continue;
    }
    const path = await categoryPathOf(item);
    // The same rules as a Whatnot listing, except photos: a show's
    // temporary listing doesn't need one.
    const problem = await whatnotProblem({ ...item, finalTitle: title, photoUrls: item.photoUrls.length ? item.photoUrls : ["-"] } as Item, path);
    if (problem) {
      skip(problem);
      continue;
    }
    const categoryId = Number(categoryFor(path, map)?.id ?? FALLBACK_CATEGORY);
    const csvCategory = WHATNOT_CSV_CATEGORIES[categoryId] ?? WHATNOT_CSV_CATEGORIES[FALLBACK_CATEGORY];
    const [category, subCategory, newCondition, usedCondition] = csvCategory;
    const condition = !item.condition || item.condition === "new" || item.condition === "new_other" ? newCondition : usedCondition;
    // What it's worth: the load's retail for the listing unit, else its
    // own price, in whole dollars (Whatnot takes no cents).
    const worth = retail.get(item.id) ?? (item.price != null ? Number(item.price) : 0);
    const price = Math.max(1, Math.round(worth));
    const cost = costPerListingUnit(item, maps).cost;
    const images = item.photoUrls.filter((u) => /^https:\/\//i.test(u)).slice(0, 8);
    lines.push(
      [
        category,
        subCategory,
        title.slice(0, 200),
        description({ ...item, finalDescription: item.finalDescription ?? item.aiDescription }),
        quantity,
        "Giveaway",
        price,
        shippingProfileFor(packageWeightOz(item)),
        "FALSE",
        whatnotHazmat(title, path),
        condition ?? "",
        cost > 0 ? cost.toFixed(2) : "",
        item.sku,
        ...Array.from({ length: 8 }, (_, i) => images[i] ?? ""),
      ]
        .map(field)
        .join(",")
    );
    rows.push({ sku: item.sku, title, quantity });
  }
  return { csv: `${lines.join("\r\n")}\r\n`, rows, skipped, itemIds: items.filter((i) => rows.some((r) => r.sku === i.sku)).map((i) => i.id), binCodes: codes };
}
