// Shapes for the dud box APIs (/api/dud-boxes) and the pages that use them
// (sort station, /duds, the scan page's "list from a dud box"). Safe to
// import from client components: no server imports here.

// What happens to a dud product once someone processes the box:
//   shopify    list it, Shopify & Whatnot only (from the box, at the listing station)
//   not_worth  not even worth Shopify
//   toss       a real dud, throw it out
//   donate     a real dud, give it away
export const DUD_DECISIONS = ["shopify", "not_worth", "toss", "donate"] as const;
export type DudDecision = (typeof DUD_DECISIONS)[number];

export function isDudDecision(v: unknown): v is DudDecision {
  return typeof v === "string" && (DUD_DECISIONS as readonly string[]).includes(v);
}

// open = the sorter is still filling it, closed = full and waiting to be
// processed, done = every product decided and the Shopify ones listed
// (set on its own, never by hand).
export type DudBoxStatus = "open" | "closed" | "done";

// Owner only: the Analyzer's numbers for one physical unit, so "not worth
// Shopify" is an informed call. null fields = the Analyzer found no price.
export type DudMoneyHint = {
  // Expected eBay sale price, and what's left after eBay fees and shipping.
  ebayPrice: number | null;
  ebayNet: number | null;
  // The store price on Shopify/Whatnot (shopifyPriceFor), after Whatnot's
  // fees (the higher of the two stores'; the buyer pays shipping there).
  shopNet: number | null;
};

// GET /api/dud-boxes/{code}. The scan page codes against box + entries'
// listed fields; keep them as they are (adding fields is fine).
export type DudBoxEntry = {
  id: string;
  upc: string;
  description: string;
  quantity: number;
  listedUnits: number;
  decision: DudDecision | null;
  decidedBy: string | null;
  decidedAt: string | null;
  // Why it's a dud, in plain words (the Analyzer's call, eBay's banned
  // list, or the sorter's own call).
  dudReason: string;
  note: string | null;
  recordedBy: string | null;
  createdAt: string;
  // Owner only (absent for employees).
  money?: DudMoneyHint | null;
};

export type DudBoxDetail = {
  box: {
    code: string;
    status: DudBoxStatus;
    manifestId: string;
    manifestTitle: string;
    createdBy: string | null;
    createdAt: string;
    closedAt: string | null;
    doneAt: string | null;
  };
  entries: DudBoxEntry[];
};

// One row of GET /api/dud-boxes.
export type DudBoxSummary = {
  code: string;
  status: DudBoxStatus;
  manifestId: string;
  manifestTitle: string;
  entryCount: number;
  // Entries nobody has decided yet.
  undecided: number;
  units: number;
  // Shopify-decided units, and how many of those are listed so far.
  shopifyUnits: number;
  listedUnits: number;
  createdBy: string | null;
  createdAt: string;
  closedAt: string | null;
  doneAt: string | null;
};
