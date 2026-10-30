import { prisma } from "../prisma";
import { lookupUpc } from "../upcLookup";
import { WarehouseError } from "./bins";
import { normalizeCode } from "./codes";
import { findSortBox, logSorted, undoSorted } from "./sortBoxes";
import { matchLineCode } from "./sortCheck";
import type { CodeLabelPayload } from "./types";

// The sort station's side of sort boxes (sortBoxes.ts holds the box
// contents rules): box summaries for the page and the box admin, logging a
// good scan with the server deciding whether it's on the manifest, undoing
// the last log, and marking a load's sorting finished. Server only.

// Sort boxes are reused load to load, so the label never names a load.
export function sortBoxLabelPayload(code: string): CodeLabelPayload {
  return { code, caption: "SORT BOX" };
}

export type SortBoxSummary = {
  code: string;
  // The load it's tied to (null = never used). A box whose units have all
  // been pulled to listing is free again even while still tied.
  manifestId: string | null;
  manifestTitle: string | null;
  // Units still physically in it / sorted into it for its current load.
  unitsLeft: number;
  unitsSorted: number;
  free: boolean;
  assignedAt: string | null;
};

type BoxRow = {
  code: string;
  manifestId: string | null;
  assignedAt: Date | null;
  manifest: { title: string } | null;
  entries: { manifestId: string; quantity: number; pulledUnits: number }[];
};

function summarize(b: BoxRow): SortBoxSummary {
  const unitsLeft = b.entries.reduce((sum, e) => sum + e.quantity - e.pulledUnits, 0);
  return {
    code: b.code,
    manifestId: b.manifestId,
    manifestTitle: b.manifest?.title ?? null,
    unitsLeft,
    unitsSorted: b.entries.filter((e) => e.manifestId === b.manifestId).reduce((sum, e) => sum + e.quantity, 0),
    free: unitsLeft === 0,
    assignedAt: b.assignedAt?.toISOString() ?? null,
  };
}

const BOX_INCLUDE = {
  manifest: { select: { title: true } },
  entries: { select: { manifestId: true, quantity: true, pulledUnits: true } },
} as const;

export async function getSortBoxSummary(rawCode: string): Promise<SortBoxSummary> {
  const box = await findSortBox(prisma, rawCode);
  return summarize(await prisma.sortBox.findUniqueOrThrow({ where: { id: box.id }, include: BOX_INCLUDE }));
}

// Every sort box, in code order. Hundreds at most, so built in one go.
export async function listSortBoxes(): Promise<SortBoxSummary[]> {
  const boxes = await prisma.sortBox.findMany({ orderBy: { code: "asc" }, include: BOX_INCLUDE });
  return boxes.map(summarize);
}

// A "Good" at the sort station. The server matches the scan to a manifest
// line (loosely, like the check) and stores the line's UPC, so the List
// page and the manifest page find it exactly. A scan that isn't on the
// manifest only goes in as an extra when the sorter said so. boxCode null
// = a load sorted without boxes (box comes back null too).
export async function logGood(args: {
  boxCode: string | null;
  manifestId: string;
  code: string;
  quantity: number;
  extra: boolean;
  by: string | null;
}) {
  const scanned = args.code.trim();
  if (!scanned) throw new WarehouseError("Scan the item first.");
  const lines = await prisma.manifestLine.findMany({
    where: { manifestId: args.manifestId },
    select: { id: true, upc: true, supplierSku: true },
  });
  const upc = matchLineCode(lines, scanned);
  if (!upc && !args.extra) {
    throw new WarehouseError("That isn't on this manifest. Box it as an extra if it's good.");
  }
  const entry = await logSorted({
    boxCode: args.boxCode,
    manifestId: args.manifestId,
    upc: upc ?? scanned,
    quantity: args.quantity,
    extra: !upc,
    by: args.by,
  });
  return { entry, box: args.boxCode ? await getSortBoxSummary(args.boxCode) : null };
}

// Names an extra after it's boxed (run after the response, so the sorter
// never waits on it): the newest listing of that UPC's title if we've had
// it before, else the UPC database's. Saved on every unnamed extra of that
// UPC on the load. Nothing found = stays unnamed (the manifest page then
// shows the UPC, or the title once it's listed).
export async function nameExtra(entryId: string) {
  try {
    const entry = await prisma.sortBoxEntry.findUnique({
      where: { id: entryId },
      select: { manifestId: true, upc: true, extra: true, name: true },
    });
    if (!entry?.extra || entry.name) return;
    const d = entry.upc.replace(/\D/g, "");
    if (d.length < 6) return;
    const variants = [...new Set([d, d.replace(/^0+/, ""), d.padStart(12, "0"), d.padStart(13, "0")])];
    const listed = await prisma.item.findFirst({
      where: { upc: { in: variants }, OR: [{ finalTitle: { not: null } }, { aiTitle: { not: null } }] },
      orderBy: { createdAt: "desc" },
      select: { finalTitle: true, aiTitle: true },
    });
    let name = listed?.finalTitle?.trim() || listed?.aiTitle?.trim() || null;
    if (!name) {
      const found = (await lookupUpc(d)) as { items?: { title?: string }[] };
      name = found.items?.[0]?.title?.trim() || null;
    }
    if (!name) return;
    await prisma.sortBoxEntry.updateMany({
      where: { manifestId: entry.manifestId, upc: entry.upc, extra: true, name: null },
      data: { name },
    });
  } catch (e) {
    console.error(`[sortStation] naming extra ${entryId} failed`, e);
  }
}

export type UndoKind = "good" | "dud" | "damaged";

// Undo a log from the sort station (the page offers it for its own last
// log). Only the person who logged it, or the owner. Dud units that were
// already decided or listed from the box stay: they've moved on.
export async function undoSortLog(args: { kind: UndoKind; id: string; user: { username: string; role: string } }) {
  const mine = (recordedBy: string | null) => args.user.role === "owner" || recordedBy === args.user.username;
  const notYours = new WarehouseError("Only whoever logged it (or the owner) can undo it.", 403);
  if (args.kind === "good") {
    const e = await prisma.sortBoxEntry.findUnique({ where: { id: args.id }, select: { recordedBy: true } });
    if (!e) throw new WarehouseError("That sort scan is already gone.", 404);
    if (!mine(e.recordedBy)) throw notYours;
    await undoSorted(args.id);
    return;
  }
  if (args.kind === "dud") {
    const e = await prisma.manifestDudEntry.findUnique({ where: { id: args.id } });
    if (!e) throw new WarehouseError("That dud is already gone.", 404);
    if (!mine(e.recordedBy)) throw notYours;
    if (e.listedUnits > 0 || e.decision) {
      throw new WarehouseError(
        "Someone already decided or listed these from the dud box, so it can't be undone here.",
        409
      );
    }
    // Only if nobody touched it since (a decision landing at the same time).
    const gone = await prisma.manifestDudEntry.deleteMany({ where: { id: e.id, listedUnits: 0, decision: null } });
    if (gone.count === 0) throw new WarehouseError("That dud changed in the meantime. Check the dud box.", 409);
    return;
  }
  const e = await prisma.manifestDamagedEntry.findUnique({ where: { id: args.id }, select: { recordedBy: true } });
  if (!e) throw new WarehouseError("That entry is already gone.", 404);
  if (!mine(e.recordedBy)) throw notYours;
  await prisma.manifestDamagedEntry.delete({ where: { id: args.id } });
}

// "Sorting done" for a load: the whole load has been through the sort
// station, so lines with nothing sorted are really short (not just not
// reached yet). undo clears it (the route only lets the owner do that).
export async function setSortingDone(args: { manifestId: string; done: boolean; by: string | null }) {
  const manifest = await prisma.manifest.findUnique({ where: { id: args.manifestId }, select: { id: true } });
  if (!manifest) throw new WarehouseError("That load doesn't exist anymore.", 404);
  const updated = await prisma.manifest.update({
    where: { id: args.manifestId },
    data: args.done ? { sortedAt: new Date(), sortedBy: args.by } : { sortedAt: null, sortedBy: null },
    select: { sortedAt: true, sortedBy: true },
  });
  return { sortedAt: updated.sortedAt?.toISOString() ?? null, sortedBy: updated.sortedBy };
}

// Box codes from..to inclusive ("SB0001".."SB0040"), for printing a range.
export async function sortBoxCodesInRange(fromRaw: string, toRaw: string): Promise<string[]> {
  const from = normalizeCode(fromRaw);
  const to = normalizeCode(toRaw || fromRaw);
  const boxes = await prisma.sortBox.findMany({ select: { code: true } });
  const num = (c: string) => Number(c.replace(/\D/g, ""));
  const lo = Math.min(num(from), num(to));
  const hi = Math.max(num(from), num(to));
  if (!Number.isFinite(lo) || !Number.isFinite(hi) || lo <= 0) throw new WarehouseError("Enter box codes like SB0001.");
  return boxes
    .map((b) => b.code)
    .filter((c) => num(c) >= lo && num(c) <= hi)
    .sort((a, b) => num(a) - num(b));
}

// Who else logged anything on this load at the sort station lately (good,
// dud, damaged/expired, set aside for the supplier), newest first, for the
// "Is everyone done?" popup before marking sorting done. Not the asker.
export async function recentSorters(args: { manifestId: string; exclude: string; minutes: number }) {
  const where = {
    manifestId: args.manifestId,
    createdAt: { gte: new Date(Date.now() - args.minutes * 60 * 1000) },
    recordedBy: { not: args.exclude },
  };
  // Half an hour of one load's scans: small enough to just read.
  const select = { recordedBy: true, createdAt: true } as const;
  const rows = (
    await Promise.all([
      prisma.sortBoxEntry.findMany({ where, select }),
      prisma.manifestDudEntry.findMany({ where, select }),
      prisma.manifestDamagedEntry.findMany({ where, select }),
      prisma.consignmentReturnEntry.findMany({ where, select }),
    ])
  ).flat();
  const last = new Map<string, Date>();
  for (const r of rows) {
    const at = r.createdAt;
    if (!r.recordedBy) continue;
    const prev = last.get(r.recordedBy);
    if (!prev || at > prev) last.set(r.recordedBy, at);
  }
  return [...last.entries()]
    .sort((a, b) => b[1].getTime() - a[1].getTime())
    .map(([username, at]) => ({ username, lastAt: at.toISOString() }));
}
