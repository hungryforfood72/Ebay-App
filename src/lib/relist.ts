import type { Item, Prisma } from "@/generated/prisma/client";
import { AUTO_EXPIRED_NOTE } from "./expireListings";
import type { ExpirationBatch, ExpirySplit } from "./expirationBreakdown";
import { prisma } from "./prisma";
import { removeUnitsBestEffort } from "./warehouse/bins";

// Guided relist of a multi-date listing the expiration sweep pulled
// (Item.expirySplit). The dashboard sends staff to /scan?relist={id}, which
// walks them through new photos of the still-good units (a new eBay
// listing), then the past-date ones (Shopify & Whatnot only), on the
// original's manifest, so nobody has to work out which load it came from.
// Cristian, 2026-10-15.
export type RelistPart = "good" | "past";

// What each part has become: the new Item's id, or "logged" for past-date
// units written off as expired (no past-date lane for that category).
export type RelistProgress = { good?: string; past?: string };
type StoredSplit = ExpirySplit & { relisted?: RelistProgress };

export type RelistPartPlan = {
  batches: ExpirationBatch[];
  units: number;
  done: boolean;
  // How to list these units: the original's shape (a pack stays a pack).
  quantity: number;
  isMultipack: boolean;
  packSize: number | null;
};

export type RelistPlan = {
  id: string;
  title: string;
  upc: string | null;
  manifestId: string | null;
  shelfLocation: string;
  boxSize: string | null;
  pastDateLane: boolean;
  good: RelistPartPlan;
  past: RelistPartPlan;
  // The part to do now, null when both are done.
  next: RelistPart | null;
};

function partPlan(original: Item, batches: ExpirationBatch[], done: boolean): RelistPartPlan {
  const units = batches.reduce((sum, b) => sum + b.units, 0);
  // A multi-pack's units go back out as one pack of what's left (a single
  // when it's one unit); separate singles stay separate singles.
  const asPack = original.isMultipack && units > 1;
  return {
    batches,
    units,
    done,
    quantity: original.isMultipack ? 1 : units,
    isMultipack: asPack,
    packSize: asPack ? units : null,
  };
}

function storedSplit(item: Item): StoredSplit | null {
  const split = item.expirySplit as StoredSplit | null;
  return split && Array.isArray(split.stillGood) && Array.isArray(split.pastDate) ? split : null;
}

export function relistPlan(original: Item): RelistPlan | null {
  const split = storedSplit(original);
  if (!split || original.status !== "expired") return null;
  const relisted = split.relisted ?? {};
  const pastDateLane = split.pastDateLane !== false;
  const good = partPlan(original, split.stillGood, Boolean(relisted.good));
  const past = partPlan(original, split.pastDate, Boolean(relisted.past));
  return {
    id: original.id,
    title: original.finalTitle ?? original.aiTitle ?? original.sku,
    upc: original.upc,
    manifestId: original.manifestId,
    shelfLocation: original.shelfLocation,
    boxSize: original.boxSize,
    pastDateLane,
    good,
    past,
    next: !good.done ? "good" : !past.done ? "past" : null,
  };
}

// What the new listing keeps from the original: category, condition and
// item specifics (not the old date, which the new scan supplies), so the
// review step has less to redo. The draft still runs on the new photos.
export function inheritedFields(original: Item): {
  categoryId: string | null;
  condition: Item["condition"];
  itemSpecifics: Prisma.InputJsonValue | undefined;
} {
  const specifics = { ...((original.itemSpecifics as Record<string, string> | null) ?? {}) };
  delete specifics["Expiration Date"];
  return {
    categoryId: original.categoryId,
    condition: original.condition,
    itemSpecifics: Object.keys(specifics).length > 0 ? specifics : undefined,
  };
}

// Records a finished part on the original. Saving the good units of an item
// with no past-date lane also writes the past-date units off as expired on
// the manifest (they're tossed, there's nothing to scan). Once both parts
// are done the shelf-pull card is cleared. Returns the part still to do.
export async function recordRelistPart(originalId: string, part: RelistPart, newItemId: string): Promise<RelistPart | null> {
  const original = await prisma.item.findUniqueOrThrow({ where: { id: originalId } });
  const split = storedSplit(original);
  if (!split) return null;
  const relisted: RelistProgress = { ...(split.relisted ?? {}), [part]: newItemId };

  const writeOffs: Prisma.PrismaPromise<unknown>[] = [];
  if (part === "good" && split.pastDateLane === false && !relisted.past) {
    relisted.past = "logged";
    const units = split.pastDate.reduce((sum, b) => sum + b.units, 0);
    if (original.manifestId && original.upc && units > 0) {
      writeOffs.push(
        prisma.manifestDamagedEntry.create({
          data: { manifestId: original.manifestId, upc: original.upc, quantity: units, note: AUTO_EXPIRED_NOTE, recordedBy: null },
        })
      );
    }
  }

  const finished = Boolean(relisted.good && relisted.past);
  await prisma.$transaction([
    ...writeOffs,
    prisma.item.update({
      where: { id: originalId },
      data: {
        expirySplit: { ...split, relisted } as unknown as Prisma.InputJsonValue,
        ...(finished ? { shelfPullAcknowledgedAt: new Date() } : {}),
      },
    }),
  ]);
  if (finished) {
    // Warehouse mode: every unit of the original has been re-scanned under
    // new labels, so its old bins stop counting it (same moment the
    // shelf-pull card clears). Best effort, after the relist is recorded:
    // a busy bin never fails the relist. Nothing to do for items with no
    // bins.
    await removeUnitsBestEffort({
      itemId: originalId,
      units: "all",
      kind: "pull",
      by: null,
      note: "Relisted after expiry split",
    });
  }
  return !relisted.good ? "good" : !relisted.past ? "past" : null;
}
