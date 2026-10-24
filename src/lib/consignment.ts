import { ebayBanReason } from "./ebayBanned";
import { MIN_PROFIT_PER_SALE } from "./packSize";
import { prisma } from "./prisma";
import { lineKey } from "./upcMatch";
import {
  expiresByDate,
  getLongTailMonths,
  getMaxMonthsToSellThrough,
  STALLED_MONTHS_SENTINEL,
} from "./sourcingAgent";

// ---------------------------------------------------------------------------
// Consignment pick list. Cristian 2026-10-17: a local supplier's medical
// load on consignment. He pays the supplier a share of the profit (after
// eBay fees and the label) only when something sells, picks what he wants,
// and can give back what doesn't sell. So there's no bid: the question per
// product is "take it, and how many".
//
// Built from the latest evaluation's numbers on every page load (no eBay
// calls), so changing the supplier's share updates it immediately:
//   - loses money, banned on eBay, dead event/holiday stock, or our share
//     under MIN_PROFIT_PER_SALE: skip
//   - sells within the slow-seller window (6 months, or 12 if it doesn't
//     expire): take all of it
//   - slower than that: take only what should sell inside the window (the
//     rest stays with the supplier; nothing to buy, nothing stuck)
//   - no sell-speed data: a trial amount, since unsold units go back
//   - live listings show no sales at all: skip
// ---------------------------------------------------------------------------

export const DEFAULT_CONSIGNMENT_SUPPLIER_PCT = 50;
export const CONSIGNMENT_TRIAL_UNITS = 3;

export type ConsignmentPick = {
  estimateId: string;
  upc: string | null;
  itemNumbers: string[];
  // The sort station's keys for its lines (lineKey): how a product with no
  // UPC is found there.
  lineKeys: string[];
  description: string;
  availableUnits: number;
  takeUnits: number;
  // Pieces per unit, for other-supplier manifests priced by the box.
  piecesPerUnit: number | null;
  netPerUnit: number | null;
  yourSharePerUnit: number | null;
  monthsToSellThrough: number | null;
  reason: string;
};

export type ConsignmentPickList = {
  supplierPct: number;
  picks: ConsignmentPick[];
  skipped: ConsignmentPick[];
  takeUnits: number;
  yourProfit: number;
  supplierPayout: number;
};

function months(n: number) {
  return n < 1.5 ? "about a month" : `~${Math.round(n)} months`;
}

export async function buildConsignmentPickList(manifestId: string, supplierPct: number): Promise<ConsignmentPickList | null> {
  const [evaluation, lines] = await Promise.all([
    prisma.sourcingEvaluation.findFirst({
      where: { manifestId, status: "complete" },
      orderBy: { startedAt: "desc" },
      include: { lineEstimates: true },
    }),
    prisma.manifestLine.findMany({
      where: { manifestId },
      select: { id: true, upc: true, supplierSku: true, piecesPerBox: true },
    }),
  ]);
  if (!evaluation) return null;

  const fullValueMonths = evaluation.maxMonthsToSellThrough ?? (await getMaxMonthsToSellThrough());
  const longTailMonths = evaluation.longTailMonths ?? (await getLongTailMonths());
  const keep = 1 - supplierPct / 100;

  const picks: ConsignmentPick[] = [];
  const skipped: ConsignmentPick[] = [];
  for (const e of evaluation.lineEstimates) {
    // Same grouping as the evaluation: by UPC, or the line itself.
    const groupLines = lines.filter((l) => (e.upc ? l.upc === e.upc : e.groupKey === `__no_upc_${l.id}`));
    const price = e.estimatedUnitSalePrice != null ? Number(e.estimatedUnitSalePrice) : null;
    const net =
      price != null ? price - Number(e.estimatedUnitFees ?? 0) - Number(e.estimatedUnitShipping ?? 0) : null;
    const share = net != null ? net * keep : null;
    const base: Omit<ConsignmentPick, "takeUnits" | "reason"> = {
      estimateId: e.id,
      upc: e.upc,
      itemNumbers: [...new Set(groupLines.map((l) => l.supplierSku).filter((s): s is string => Boolean(s)))],
      lineKeys: [...new Set(groupLines.map((l) => lineKey(l)).filter((k): k is string => k != null))],
      description: e.description,
      availableUnits: e.effectiveUnits,
      piecesPerUnit: groupLines.find((l) => l.piecesPerBox)?.piecesPerBox ?? null,
      netPerUnit: net,
      yourSharePerUnit: share,
      monthsToSellThrough: e.monthsToSellThrough,
    };
    const skip = (reason: string) => skipped.push({ ...base, takeUnits: 0, reason });

    const banned = ebayBanReason(e.description);
    if (banned) { skip(banned); continue; }
    if (e.eventEnded || e.postHolidayFiller) { skip("Occasion stock past its season"); continue; }
    if (net == null) { skip("No exact eBay listings to price it"); continue; }
    if (net <= 0) { skip("Loses money after eBay fees and the label"); continue; }
    if (share! < MIN_PROFIT_PER_SALE) {
      skip(`Your share is only $${share!.toFixed(2)} a unit`);
      continue;
    }

    const m = e.monthsToSellThrough;
    if (m == null) {
      const take = Math.min(e.effectiveUnits, CONSIGNMENT_TRIAL_UNITS);
      picks.push({ ...base, takeUnits: take, reason: take < e.effectiveUnits ? "No sell-speed data yet, so a trial amount" : "No sell-speed data yet, but it's a small amount" });
      continue;
    }
    if (m >= STALLED_MONTHS_SENTINEL) { skip("Live eBay listings of it show no sales"); continue; }

    const expiring = m > fullValueMonths ? await expiresByDate(e.upc, e.description) : false;
    const window = expiring ? fullValueMonths : longTailMonths;
    if (m <= window) {
      picks.push({ ...base, takeUnits: e.effectiveUnits, reason: `All of it should sell in ${months(m)}` });
      continue;
    }
    const take = Math.floor((e.effectiveUnits * window) / m);
    if (take < 1) {
      skip(`Too slow: one would take ${months(m / e.effectiveUnits)}`);
      continue;
    }
    picks.push({
      ...base,
      takeUnits: take,
      reason: `All ${e.effectiveUnits} would take ${months(m)}, so take what sells in ${window}${expiring ? " (it expires)" : ""}`,
    });
  }

  const value = (p: ConsignmentPick) => p.takeUnits * (p.yourSharePerUnit ?? 0);
  picks.sort((a, b) => value(b) - value(a));
  return {
    supplierPct,
    picks,
    skipped,
    takeUnits: picks.reduce((s, p) => s + p.takeUnits, 0),
    yourProfit: picks.reduce((s, p) => s + value(p), 0),
    supplierPayout: picks.reduce((s, p) => s + p.takeUnits * (p.netPerUnit ?? 0) * (supplierPct / 100), 0),
  };
}
