import { Prisma } from "@/generated/prisma/client";
import { naturalSort } from "../naturalSort";
import { prisma } from "../prisma";
import { upcMatchKeys } from "../upcMatch";
import { getItemLocations, removeUnits, removeUnitsBestEffort } from "./bins";
import { classifyScan, normalizeCode } from "./codes";
import {
  ITEM_SELECT,
  conditionLabel,
  describeScan,
  itemTitle,
  itemUpcKeys,
  monthYear,
  packText,
  verifyFor,
  type MatchedItem,
  type ScannedItem,
  type VerifyBy,
} from "./picking";
import type { BinLocation } from "./types";

// Pulling stock off the shelves (Cristian, 2026-10-26): listings that came
// off eBay for their date, or because they're Rx only, used to be cleared
// with one "Mark as pulled" tap that emptied their bins on trust. Now it
// works like picking an order: the Pull page (/pulls) says where to go, and
// each unit's label is scanned to prove it's the right one. Every scan takes
// one unit off a bin (removeUnits, kind "pull"); when the bins are empty
// the pull is done (Item.shelfPullAcknowledgedAt). Old-system items with no
// label are checked by UPC, or a "Found it" tap when there's no barcode on
// record, and one check counts for the whole shelf.

// What's on the pull list: same rule as the Dashboard and GET /api/pulls.
// Multi-date listings (expirySplit) go through Relist instead.
export const PULL_WHERE = {
  status: "expired",
  shelfPullAcknowledgedAt: null,
  expirySplit: { equals: Prisma.AnyNull },
} satisfies Prisma.ItemWhereInput;

export type PullItem = {
  id: string;
  code: string;
  title: string;
  photo: string | null;
  expiration: string | null;
  condition: string | null;
  pack: string;
  // "rx_return": Rx only, goes back to the supplier. null: expired by date.
  reason: string | null;
  verifyBy: VerifyBy;
  // For checking a UPC scan on the handheld before asking the server.
  upcKeys: string[];
  // Units still in bins, and units pulled by scan so far.
  left: number;
  pulled: number;
  bins: BinLocation[];
  // Old system: the shelf it sits on (no bins).
  legacyShelf: string | null;
  // Shared with Dashboard / PullBanner callers of GET /api/pulls.
  finalTitle: string | null;
  sku: string;
  shelfLocation: string;
  pullReason: string | null;
  location: { bins: BinLocation[]; legacyShelf: string | null } | null;
};

async function pulledSoFar(items: { id: string; expiredAt: Date | null }[]): Promise<Map<string, number>> {
  if (items.length === 0) return new Map();
  const moves = await prisma.binMove.findMany({
    where: { kind: "pull", itemId: { in: items.map((i) => i.id) } },
    select: { itemId: true, units: true, createdAt: true },
  });
  const since = new Map(items.map((i) => [i.id, i.expiredAt?.getTime() ?? 0]));
  const out = new Map<string, number>();
  for (const m of moves) {
    if (!m.itemId || m.createdAt.getTime() < (since.get(m.itemId) ?? 0)) continue;
    out.set(m.itemId, (out.get(m.itemId) ?? 0) + (m.units ?? 0));
  }
  return out;
}

// Everything to pull, in walking order: shelf, then bin.
export async function getPullList(): Promise<PullItem[]> {
  const items = await prisma.item.findMany({
    where: PULL_WHERE,
    orderBy: { expiredAt: "asc" },
    select: { ...ITEM_SELECT, expiredAt: true, pullReason: true },
  });
  const [locations, pulled] = await Promise.all([getItemLocations(items), pulledSoFar(items)]);
  const list = items.map((item): PullItem => {
    const loc = locations.get(item.id) ?? null;
    const verifyBy = verifyFor(item);
    const bins = loc?.bins ?? [];
    return {
      id: item.id,
      code: item.sku,
      title: itemTitle(item),
      photo: item.photoUrls[0] ?? null,
      expiration: monthYear(item.expirationDate),
      condition: conditionLabel(item.condition),
      pack: packText(item),
      reason: item.pullReason,
      verifyBy,
      upcKeys: verifyBy === "label" ? [] : itemUpcKeys(item),
      left: bins.reduce((n, b) => n + b.units, 0),
      pulled: pulled.get(item.id) ?? 0,
      bins,
      legacyShelf: loc?.legacyShelf ?? (bins.length ? null : item.shelfLocation || null),
      finalTitle: item.finalTitle,
      sku: item.sku,
      shelfLocation: item.shelfLocation,
      pullReason: item.pullReason,
      location: loc,
    };
  });
  const place = (p: PullItem) => `${p.bins[0]?.shelfLabel ?? p.legacyShelf ?? "~"} ${p.bins[0]?.binCode ?? ""}`;
  return naturalSort(list, place);
}

export type PullScanRequest = {
  scannedCode: string;
  // The bin the person said they're at (scanned its label): units come off
  // that bin's count first.
  binCode?: string | null;
  // "Found it" on an item with no label and no UPC on record.
  itemId?: string | null;
  manual?: boolean;
};

export type PullScanResponse =
  | {
      ok: true;
      itemId: string;
      code: string;
      title: string;
      reason: string | null;
      takenFromBin: string | null;
      left: number;
      pulled: number;
      done: boolean;
      binNote: string | null;
      manual: boolean;
    }
  | {
      ok: false;
      code: "not_on_list" | "not_an_item" | "scan_label" | "already_done";
      reason: string;
      scannedItem?: ScannedItem | null;
    };

type OpenItem = MatchedItem & { expiredAt: Date | null; pullReason: string | null };

export async function pullScan(req: PullScanRequest, by: string | null): Promise<PullScanResponse> {
  const scanned = normalizeCode(req.scannedCode ?? "");
  const kind = classifyScan(scanned);
  const open: OpenItem[] = await prisma.item.findMany({
    where: PULL_WHERE,
    select: { ...ITEM_SELECT, expiredAt: true, pullReason: true },
  });

  let item: OpenItem | null = null;
  let manual = false;
  if (req.manual && req.itemId) {
    item = open.find((i) => i.id === req.itemId) ?? null;
    if (!item) return { ok: false, code: "already_done", reason: "That one's already pulled." };
    if (verifyFor(item) !== "tap") {
      return {
        ok: false,
        code: "scan_label",
        reason: verifyFor(item) === "label" ? "Scan its label to pull it." : "Scan its barcode (UPC) to pull it.",
      };
    }
    manual = true;
  } else if (scanned) {
    item = open.find((i) => normalizeCode(i.sku) === scanned) ?? null;
    if (!item && kind === "upc") {
      const keys = new Set(upcMatchKeys(scanned));
      const byUpc = open.filter((i) => itemUpcKeys(i).some((k) => keys.has(k)));
      const unlabelled = byUpc.filter((i) => verifyFor(i) !== "label");
      if (unlabelled.length) {
        item = unlabelled.find((i) => i.id === req.itemId) ?? unlabelled[0];
      } else if (byUpc.length) {
        return { ok: false, code: "scan_label", reason: "Scan the app's label on it (ES…), not the product barcode." };
      }
    }
  }

  if (!item) {
    if (kind !== "item" && kind !== "upc") {
      return { ok: false, code: "not_an_item", reason: "That's not an item label or barcode." };
    }
    const scannedItem = await describeScan(scanned);
    return {
      ok: false,
      code: "not_on_list",
      reason: scannedItem ? "That one isn't being pulled. Leave it where it is." : "The app doesn't know that label.",
      scannedItem,
    };
  }

  const preferBinCode = req.binCode ? normalizeCode(req.binCode) : null;
  const target = item;
  const result = await prisma.$transaction(async (tx) => {
    const fresh = await tx.item.findUnique({ where: { id: target.id }, select: { shelfPullAcknowledgedAt: true } });
    if (fresh?.shelfPullAcknowledgedAt) return null;
    const hadBins = (await tx.binContent.aggregate({ where: { itemId: target.id }, _sum: { units: true } }))._sum.units ?? 0;
    const taken = hadBins
      ? await removeUnits(tx, { itemId: target.id, units: 1, kind: "pull", by, preferBinCode, note: manual ? "Pulled (Found it)" : "Pulled (scanned)" })
      : [];
    const left = (await tx.binContent.aggregate({ where: { itemId: target.id }, _sum: { units: true } }))._sum.units ?? 0;
    // Bins empty (or an old-system item, all on its shelf): pulled.
    const done = left === 0;
    if (done) {
      await tx.item.update({ where: { id: target.id }, data: { shelfPullAcknowledgedAt: new Date(), shelfPullAcknowledgedBy: by } });
    }
    return { taken, left, done };
  });
  if (!result) return { ok: false, code: "already_done", reason: "That one's already pulled." };

  const takenFromBin = result.taken[0]?.binCode ?? null;
  const pulled = (await pulledSoFar([target])).get(target.id) ?? 0;
  const binNote =
    preferBinCode && takenFromBin && takenFromBin !== preferBinCode
      ? `${preferBinCode} didn't have it on record, so it came off ${takenFromBin}'s count.`
      : null;
  return {
    ok: true,
    itemId: target.id,
    code: target.sku,
    title: itemTitle(target),
    reason: target.pullReason,
    takenFromBin,
    left: result.left,
    pulled,
    done: result.done,
    binNote,
    manual,
  };
}

// "Can't find the rest": the pull is finished with what was found, and the
// bins stop counting the rest (noted as not found, for the activity log
// and bin history).
export async function finishPull(itemId: string, by: string | null, notFound: boolean) {
  const item = await prisma.item.findUnique({ where: { id: itemId }, select: { status: true, shelfPullAcknowledgedAt: true } });
  if (!item) return { error: "Item not found.", status: 404 } as const;
  if (item.status !== "expired") return { error: "This item isn't marked expired.", status: 400 } as const;
  if (!item.shelfPullAcknowledgedAt) {
    await prisma.item.update({ where: { id: itemId }, data: { shelfPullAcknowledgedAt: new Date(), shelfPullAcknowledgedBy: by } });
  }
  await removeUnitsBestEffort({
    itemId,
    units: "all",
    // Not found = a count correction, not units that left on the cart.
    kind: notFound ? "adjust" : "pull",
    by,
    note: notFound ? "Not found at pull (couldn't find the rest)" : "Pulled (expired)",
  });
  return { ok: true } as const;
}
