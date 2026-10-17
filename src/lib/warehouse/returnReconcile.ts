import type { Prisma } from "@/generated/prisma/client";
import { parseBundleComponentUnits, unitsFor } from "../itemUnits";
import { prisma } from "../prisma";

// Customer returns put units back on the manifest's Items (returns.ts):
//   add_back                            raises the original Item.quantity
//   relist_same/relist_new/shopify_only a NEW Item on the same manifest
//                                       (ItemReturn.newItemId, set once listed)
// and the units of a return that won't be listed are written onto the
// original's manifest when the return is saved: thrown out and missing as
// damaged entries, donated as a dud entry (notes below).
//
// Manifest reconciliation counts received as the units of its Items, and
// those still count every unit the original listing ever had (sold or not).
// So a return would be counted twice: once still in received, and again as
// the relisted Item or the new damaged/dud entry. Cristian's example: a
// 3-pack sold and came back with one unit damaged; the 2 good ones were
// relisted as a 2-pack and the damaged one thrown out. Received must end up
// 2 and damaged 1 (3 accounted), not 3 + 2 received and 1 damaged. This
// works out, per UPC, how many received units are really returns, for the
// reconciliation to take back off: units added back, units relisted (up to
// what the return said to list) and the units the return wrote as damaged
// or dud. Sold units and revenue stay as they are: the new listing's sale
// is a real, separate sale. Server only.

// Notes on the damaged/dud entries a return writes. They balance against
// received here, so anything that reads damaged/dud entries WITHOUT this
// received adjustment (the scan-speed report, the Analyzer's damage rate
// and dud tracking, a hand count) leaves them out with NOT_RETURN_ENTRY.
export const RETURN_NOTE_PREFIX = "Return: ";
export const RETURN_NOTE_THROWN = `${RETURN_NOTE_PREFIX}damaged, thrown out`;
export const RETURN_NOTE_MISSING = `${RETURN_NOTE_PREFIX}missing from the box`;
export const RETURN_NOTE_DONATED = `${RETURN_NOTE_PREFIX}donated`;

// Prisma filter for damaged/dud entries that didn't come from a return.
// note IS NULL has to be its own branch: NOT (note LIKE ...) is unknown
// for a null note, which would drop every entry without one.
export const NOT_RETURN_ENTRY = {
  OR: [{ note: null }, { NOT: { note: { startsWith: RETURN_NOTE_PREFIX } } }],
} satisfies Prisma.ManifestDamagedEntryWhereInput & Prisma.ManifestDudEntryWhereInput;

type ItemShape = {
  upc: string | null;
  isMultipack: boolean;
  packSize: number | null;
  isBundle: boolean;
  bundleComponents: unknown;
};

const ITEM_SELECT = { upc: true, isMultipack: true, packSize: true, isBundle: true, bundleComponents: true } as const;

// What returns.ts stores in ItemReturn.report that matters here.
type StoredBits = {
  plan?: { listUnits?: number; returnedUnits?: number };
  leftoverEntries?: { damaged?: number; dud?: number };
};

const add = (into: Map<string, number>, upc: string, units: number) => into.set(upc, (into.get(upc) ?? 0) + units);

// Physical units per UPC for `quantity` listing units of an item, counted
// the way GET /api/manifests/[id] counts received (a bundle counts its
// components, a multipack its pieces).
function physicalByUpc(item: ItemShape, quantity: number, into: Map<string, number>) {
  if (item.isBundle) {
    for (const c of parseBundleComponentUnits(item.bundleComponents)) add(into, c.upc, c.unitsPerBundle * quantity);
    return;
  }
  if (!item.upc) return;
  add(into, item.upc, unitsFor({ ...item, quantity }));
}

export async function returnedUnitsByUpc(manifestId: string): Promise<Map<string, number>> {
  const returns = await prisma.itemReturn.findMany({
    // Pending = the agent was asked but nothing was done yet.
    where: { decision: { not: "pending" }, item: { manifestId } },
    select: { units: true, decision: true, newItemId: true, report: true, item: { select: ITEM_SELECT } },
  });
  const out = new Map<string, number>();
  if (returns.length === 0) return out;

  const newIds = returns.filter((r) => r.decision !== "add_back" && r.newItemId).map((r) => r.newItemId!);
  // Only a new listing on this same manifest was counted here a second time.
  const newItems = newIds.length
    ? await prisma.item.findMany({
        where: { id: { in: newIds }, manifestId },
        select: { id: true, quantity: true, ...ITEM_SELECT },
      })
    : [];
  const newById = new Map(newItems.map((i) => [i.id, i]));

  for (const r of returns) {
    const stored = (r.report ?? {}) as StoredBits;
    // Leftover entries are only written for an original with one UPC (not
    // a bundle) on this manifest, which is what this query selected.
    const leftovers = (stored.leftoverEntries?.damaged ?? 0) + (stored.leftoverEntries?.dud ?? 0);
    if (leftovers > 0 && r.item.upc && !r.item.isBundle) add(out, r.item.upc, leftovers);

    if (r.decision === "add_back") {
      // The original's quantity went up by exactly the returned units.
      physicalByUpc(r.item, r.units, out);
      continue;
    }
    // Nothing listed (dispose/donate), not listed yet (relist_new and
    // shopify_only wait for the listing step), or listed onto another
    // load: nothing more double counted.
    const created = r.newItemId ? newById.get(r.newItemId) : undefined;
    if (!created) continue;
    if (created.isBundle || r.item.isBundle) {
      // Bundles: whole bundles, at most as many as came back.
      physicalByUpc(created, Math.min(created.quantity, r.units), out);
      continue;
    }
    if (!created.upc) continue;
    // Take back what the new listing added, up to the units the return
    // said to list (all of them for a same-condition return or an older
    // row with no plan). A lister who listed more than that has found
    // extra stock, which really is received.
    const cap = stored.plan?.listUnits ?? unitsFor({ ...r.item, quantity: r.units });
    add(out, created.upc, Math.min(unitsFor(created), cap));
  }
  return out;
}
