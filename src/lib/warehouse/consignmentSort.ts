import { buildConsignmentPickList, DEFAULT_CONSIGNMENT_SUPPLIER_PCT } from "../consignment";
import { ebayBanReason } from "../ebayBanned";
import { prisma } from "../prisma";
import { lineKey, upcMatchKeys } from "../upcMatch";
import { WarehouseError } from "./bins";
import { latestCompleteEvaluationId, matchLineCode } from "./sortCheck";

// Sorting a consignment load (Cristian, 2026-10-21). The supplier delivered
// it, so what he scanned at their place may not be what showed up. The
// sort station counts what really came in, and for each product it says
// what the pick list said at the supplier's:
//   take   it's ours: good, into a sort box, as for any load
//   leave  it shouldn't have come: set it aside to go back to the supplier
// There are no dud boxes here: everything on the load is still the
// supplier's, so nothing gets tossed or donated. Anything not on the
// manifest goes back too. Server only.

export type ConsignmentCall = { decision: "take" | "leave"; reason: string | null };

// Staff read this, so no money: the pick list's own reasons quote our
// share per unit.
function leaveReason(description: string): string {
  const banned = ebayBanReason(description);
  if (banned) return banned.replace(/^eBay bans /, "eBay doesn't allow ");
  return "The pick list said to leave this at the supplier's";
}

// Building the pick list takes a couple of seconds (the medical load:
// ~2.5s), too slow for every scan. It only changes when the supplier's
// share changes or the Analyzer runs again, so it's kept per load (per
// server instance) and rebuilt when either does, or after a while.
const CALLS_CACHE_MS = 10 * 60_000;
const callsCache = new Map<string, { at: number; key: string; promise: Promise<Map<string, ConsignmentCall> | null> }>();

// Every product UPC on the load -> take or leave, from the same pick list
// pick mode used at the supplier's. null = no finished Analyzer run, so
// there's no pick list and everything counts as taken.
export async function consignmentCalls(manifestId: string): Promise<Map<string, ConsignmentCall> | null> {
  const [manifest, evaluationId] = await Promise.all([
    prisma.manifest.findUnique({ where: { id: manifestId }, select: { consignment: true, consignmentSupplierPct: true } }),
    latestCompleteEvaluationId(manifestId),
  ]);
  if (!manifest?.consignment || !evaluationId) return null;
  const pct = manifest.consignmentSupplierPct ?? DEFAULT_CONSIGNMENT_SUPPLIER_PCT;
  const key = `${evaluationId}:${pct}`;
  const cached = callsCache.get(manifestId);
  if (cached && cached.key === key && Date.now() - cached.at < CALLS_CACHE_MS) return cached.promise;
  const promise = buildCalls(manifestId, pct);
  callsCache.set(manifestId, { at: Date.now(), key, promise });
  // A failed build shouldn't be served to the next scan.
  promise.catch(() => {
    if (callsCache.get(manifestId)?.promise === promise) callsCache.delete(manifestId);
  });
  return promise;
}

async function buildCalls(manifestId: string, pct: number): Promise<Map<string, ConsignmentCall> | null> {
  const list = await buildConsignmentPickList(manifestId, pct);
  if (!list) return null;
  const calls = new Map<string, ConsignmentCall>();
  // Keyed like the sort station keys lines (lineKey): the UPC, or "item:" +
  // the Item # for a product with no UPC.
  const keysOf = (p: { upc: string | null; lineKeys: string[] }) => (p.upc ? [p.upc] : p.lineKeys);
  for (const p of list.skipped) for (const k of keysOf(p)) calls.set(k, { decision: "leave", reason: leaveReason(p.description) });
  // A UPC split across take and leave can't happen (one estimate per UPC),
  // but take wins if it ever does.
  for (const p of list.picks) for (const k of keysOf(p)) calls.set(k, { decision: "take", reason: null });
  return calls;
}

export function callFor(calls: Map<string, ConsignmentCall> | null, upc: string): ConsignmentCall {
  return calls?.get(upc) ?? { decision: "take", reason: null };
}

// Units set aside for the supplier, by stored UPC.
export async function returnedByUpc(manifestId: string): Promise<Map<string, number>> {
  const rows = await prisma.consignmentReturnEntry.groupBy({
    by: ["upc"],
    where: { manifestId },
    _sum: { quantity: true },
  });
  return new Map(rows.map((r) => [r.upc, r._sum.quantity ?? 0]));
}

// This product's set-aside units, matched loosely like the sort counts.
export function returnedUnitsFor(returned: Map<string, number>, upc: string): number {
  const keys = new Set(upcMatchKeys(upc));
  let total = 0;
  for (const [stored, n] of returned) {
    if (stored === upc || upcMatchKeys(stored).some((k) => keys.has(k))) total += n;
  }
  return total;
}

// "Set aside for the supplier" at the sort station.
export async function logReturn(args: { manifestId: string; code: string; quantity: number; by: string | null }) {
  const scanned = args.code.trim();
  if (!scanned) throw new WarehouseError("Scan the item first.");
  if (!Number.isInteger(args.quantity) || args.quantity < 1 || args.quantity > 10_000) {
    throw new WarehouseError("Enter how many, at least 1.");
  }
  const manifest = await prisma.manifest.findUnique({
    where: { id: args.manifestId },
    select: { consignment: true, lines: { select: { id: true, upc: true, supplierSku: true, description: true } } },
  });
  if (!manifest) throw new WarehouseError("That load doesn't exist anymore. Pick the load again.", 404);
  if (!manifest.consignment) throw new WarehouseError("Only consignment loads send things back to the supplier.");
  const upc = matchLineCode(manifest.lines, scanned);
  const description = (upc && manifest.lines.find((l) => lineKey(l) === upc)?.description) || `UPC ${scanned}`;
  return prisma.consignmentReturnEntry.create({
    data: {
      manifestId: args.manifestId,
      upc: upc ?? scanned,
      description,
      quantity: args.quantity,
      reason: upc ? "leave" : "not_on_manifest",
      recordedBy: args.by,
    },
    select: { id: true, upc: true, quantity: true },
  });
}

export async function undoReturn(args: { id: string; user: { username: string; role: string } }) {
  const e = await prisma.consignmentReturnEntry.findUnique({ where: { id: args.id }, select: { recordedBy: true } });
  if (!e) throw new WarehouseError("That entry is already gone.", 404);
  if (args.user.role !== "owner" && e.recordedBy !== args.user.username) {
    throw new WarehouseError("Only whoever logged it (or the owner) can undo it.", 403);
  }
  await prisma.consignmentReturnEntry.delete({ where: { id: args.id } });
}

// What's going back to the supplier, one row per product, for the manifest
// page.
export async function returnList(manifestId: string) {
  const rows = await prisma.consignmentReturnEntry.groupBy({
    by: ["upc", "description", "reason"],
    where: { manifestId },
    _sum: { quantity: true },
    orderBy: { description: "asc" },
  });
  return rows.map((r) => ({
    upc: r.upc,
    description: r.description,
    units: r._sum.quantity ?? 0,
    notOnManifest: r.reason === "not_on_manifest",
  }));
}
