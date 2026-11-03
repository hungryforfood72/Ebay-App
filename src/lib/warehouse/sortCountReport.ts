import { prisma } from "../prisma";
import { lineKey, upcMatchKeys } from "../upcMatch";
import { boxShortName } from "./codes";

// "Count was off" fixes (SortCountFix) for /reports/sort-counts (Cristian,
// 2026-11-02): who sorted short or over, how often against how much they
// sorted, and who reported it, so a pattern (units going missing between
// the sort and the gather) can be pinned to a person.

export type SortCountPerson = {
  person: string;
  fixes: number;
  shortFixes: number;
  shortUnits: number;
  overUnits: number;
  // Units this person sorted in the window, as first counted (before fixes).
  sortedUnits: number;
  loadsShort: number;
};

export type SortCountFixRow = {
  id: string;
  at: string;
  load: string;
  manifestId: string;
  box: string;
  product: string;
  sortedCount: number;
  foundCount: number;
  sortedBy: string | null;
  fixedBy: string | null;
  page: string;
};

const NOBODY = "(not recorded)";

function names(value: string | null): string[] {
  const list = (value ?? "").split(",").map((n) => n.trim()).filter(Boolean);
  return list.length > 0 ? list : [NOBODY];
}

export async function sortCountReport(days: number) {
  const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000);
  const fixes = await prisma.sortCountFix.findMany({ where: { createdAt: { gte: since } }, orderBy: { createdAt: "desc" } });

  const manifestIds = [...new Set(fixes.map((f) => f.manifestId))];
  const [manifests, lines, extras, sortedRows] = await Promise.all([
    prisma.manifest.findMany({ where: { id: { in: manifestIds } }, select: { id: true, title: true } }),
    prisma.manifestLine.findMany({
      where: { manifestId: { in: manifestIds } },
      select: { id: true, manifestId: true, upc: true, supplierSku: true, description: true },
    }),
    prisma.sortBoxEntry.findMany({
      where: { manifestId: { in: manifestIds }, extra: true, name: { not: null } },
      select: { manifestId: true, upc: true, name: true },
    }),
    prisma.sortBoxEntry.groupBy({ by: ["recordedBy"], where: { createdAt: { gte: since } }, _sum: { quantity: true } }),
  ]);
  const titleOf = new Map(manifests.map((m) => [m.id, m.title]));

  function productName(manifestId: string, upc: string): string {
    const wanted = new Set(upcMatchKeys(upc));
    const line = lines.find(
      (l) => l.manifestId === manifestId && (lineKey(l) === upc || upcMatchKeys(l.upc).some((k) => wanted.has(k)))
    );
    if (line?.description) return line.description;
    return extras.find((e) => e.manifestId === manifestId && e.upc === upc)?.name ?? upc;
  }

  const sorters = new Map<string, SortCountPerson & { loads: Set<string> }>();
  const fixers = new Map<string, SortCountPerson & { loads: Set<string> }>();
  const blank = (person: string) => ({ person, fixes: 0, shortFixes: 0, shortUnits: 0, overUnits: 0, sortedUnits: 0, loadsShort: 0, loads: new Set<string>() });
  // Units each sorter really sorted, as first counted: shorts were taken
  // off their entries and overs added on, so undo that for the rate.
  const firstCount = new Map<string, number>();
  for (const r of sortedRows) {
    const who = r.recordedBy ?? NOBODY;
    firstCount.set(who, (firstCount.get(who) ?? 0) + (r._sum.quantity ?? 0));
  }

  for (const f of fixes) {
    const diff = f.foundCount - f.sortedCount;
    const sorterNames = names(f.sortedBy);
    for (const who of sorterNames) {
      const p = sorters.get(who) ?? blank(who);
      p.fixes += 1;
      if (diff < 0) {
        p.shortFixes += 1;
        p.shortUnits += -diff;
        p.loads.add(f.manifestId);
      } else p.overUnits += diff;
      sorters.set(who, p);
      // Only one name's entries changed when several sorted the same box,
      // but there's no telling whose, so the rate uses the share.
      firstCount.set(who, (firstCount.get(who) ?? 0) - diff / sorterNames.length);
    }
    const fixer = f.fixedBy ?? NOBODY;
    const q = fixers.get(fixer) ?? blank(fixer);
    q.fixes += 1;
    if (diff < 0) {
      q.shortFixes += 1;
      q.shortUnits += -diff;
      q.loads.add(f.manifestId);
    } else q.overUnits += diff;
    fixers.set(fixer, q);
  }

  const finish = (m: Map<string, SortCountPerson & { loads: Set<string> }>, withSorted: boolean): SortCountPerson[] =>
    [...m.values()]
      .map(({ loads, ...p }) => ({
        ...p,
        loadsShort: loads.size,
        sortedUnits: withSorted ? Math.max(0, Math.round(firstCount.get(p.person) ?? 0)) : 0,
      }))
      .sort((a, b) => b.shortUnits - a.shortUnits || b.fixes - a.fixes);

  // Everyone who sorted in the window shows, fixes or not, so a clean
  // record is visible next to a short one.
  for (const who of firstCount.keys()) if (!sorters.has(who) && (firstCount.get(who) ?? 0) > 0) sorters.set(who, blank(who));

  const rows: SortCountFixRow[] = fixes.map((f) => ({
    id: f.id,
    at: f.createdAt.toISOString(),
    load: titleOf.get(f.manifestId) ?? "Deleted load",
    manifestId: f.manifestId,
    box: boxShortName(f.boxCode),
    product: productName(f.manifestId, f.upc),
    sortedCount: f.sortedCount,
    foundCount: f.foundCount,
    sortedBy: f.sortedBy,
    fixedBy: f.fixedBy,
    page: f.page,
  }));

  return { days, sorters: finish(sorters, true), fixers: finish(fixers, false), fixes: rows };
}
