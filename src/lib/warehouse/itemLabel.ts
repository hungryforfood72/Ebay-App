import type { Prisma } from "@/generated/prisma/client";
import { prisma } from "../prisma";
import { upcMatchKeys } from "../upcMatch";
import { queuePrintJob } from "./printJobs";
import type { ItemLabelPayload } from "./types";

// Builds what goes on an item's 1x2" label, for the first print at save
// time (POST /api/items) and for reprints (POST /api/items/[id]/labels).
// One place so a reprint looks exactly like the original.

type Tx = Prisma.TransactionClient | typeof prisma;

// Room for about two short lines at the label's font size.
const NAME_MAX = 60;

const CONDITION_TEXT: Record<string, string> = {
  new: "New",
  new_other: "New other",
  used: "Used",
  for_parts: "For parts",
};

export function truncateLabelName(name: string): string {
  const clean = name.replace(/\s+/g, " ").trim();
  return clean.length > NAME_MAX ? `${clean.slice(0, NAME_MAX - 1).trimEnd()}…` : clean;
}

// "MM/YYYY" in UTC: dates are stored as midnight UTC of the scanned day,
// so local getters could show the month before on the 1st.
export function labelExpiration(date: Date | null | undefined): string | null {
  if (!date || Number.isNaN(date.getTime())) return null;
  return `${String(date.getUTCMonth() + 1).padStart(2, "0")}/${date.getUTCFullYear()}`;
}

// The manifest's own description for this UPC, which is what the person
// holding the bag recognizes. Exact UPC first (the indexed lookup), then the
// loose match manifests need (Excel drops leading zeros and so on, see
// upcMatchKeys).
export async function manifestDescriptionFor(
  tx: Tx,
  manifestId: string | null | undefined,
  upc: string | null | undefined
): Promise<string | null> {
  if (!manifestId || !upc) return null;
  const exact = await tx.manifestLine.findFirst({
    where: { manifestId, upc },
    orderBy: { sortOrder: "asc" },
    select: { description: true },
  });
  if (exact) return exact.description;
  const keys = new Set(upcMatchKeys(upc));
  if (keys.size === 0) return null;
  const lines = await tx.manifestLine.findMany({
    where: { manifestId, upc: { not: null } },
    orderBy: { sortOrder: "asc" },
    select: { upc: true, description: true },
  });
  return lines.find((l) => upcMatchKeys(l.upc).some((k) => keys.has(k)))?.description ?? null;
}

// Off a manifest, the last listing of the same UPC usually has a real
// title by now (the AI draft runs after save, so this item's own doesn't
// exist yet).
async function earlierTitleFor(tx: Tx, upc: string | null | undefined, excludeId?: string): Promise<string | null> {
  if (!upc) return null;
  const earlier = await tx.item.findFirst({
    where: {
      upc,
      ...(excludeId ? { id: { not: excludeId } } : {}),
      OR: [{ finalTitle: { not: null } }, { aiTitle: { not: null } }],
    },
    orderBy: { createdAt: "desc" },
    select: { finalTitle: true, aiTitle: true },
  });
  return earlier?.finalTitle ?? earlier?.aiTitle ?? null;
}

export async function buildItemLabel(
  tx: Tx,
  item: {
    id?: string;
    sku: string;
    upc: string | null;
    manifestId: string | null;
    isBundle: boolean;
    isMultipack: boolean;
    packSize: number | null;
    expirationDate: Date | null;
    condition: string | null;
    finalTitle?: string | null;
    aiTitle?: string | null;
  },
  // A name the scan page already had on screen, if any.
  clientName?: string | null
): Promise<ItemLabelPayload> {
  const name =
    (item.isBundle ? null : await manifestDescriptionFor(tx, item.manifestId, item.upc)) ??
    (clientName?.trim() || null) ??
    item.finalTitle ??
    item.aiTitle ??
    (item.isBundle ? null : await earlierTitleFor(tx, item.upc, item.id)) ??
    (item.isBundle ? "Bundle" : item.upc ? `UPC ${item.upc}` : "Item");
  return {
    code: item.sku,
    name: truncateLabelName(name),
    packSize: item.isMultipack && item.packSize ? item.packSize : null,
    expiration: labelExpiration(item.expirationDate),
    condition: item.condition ? (CONDITION_TEXT[item.condition] ?? item.condition) : null,
  };
}

// queuePrintJob caps one job at 200 copies; a bigger lot (rare, but a case
// of 240 singles happens) is split into several jobs instead of failing the
// save. Returns how many labels were queued.
const MAX_COPIES_PER_JOB = 200;

export async function queueItemLabels(
  tx: Prisma.TransactionClient | typeof prisma,
  args: { stationId: string; payload: ItemLabelPayload; copies: number; by: string | null }
): Promise<number> {
  let left = args.copies;
  while (left > 0) {
    const copies = Math.min(left, MAX_COPIES_PER_JOB);
    await queuePrintJob({ stationId: args.stationId, kind: "item", payload: args.payload, copies, by: args.by }, tx);
    left -= copies;
  }
  return args.copies;
}
