// Shapes shared by the warehouse-mode pieces (listing station, station PC,
// bins, order picking). Safe to import from client components: no server
// imports here.

// What goes on a 1x2" item label. code is the item's sku, which is also its
// eBay custom label, printed as a Code 128 barcode.
export type ItemLabelPayload = {
  code: string;
  // Short product name for a person glancing at the bag (manifest
  // description or UPC lookup title; the AI title doesn't exist yet when the
  // label prints).
  name: string;
  packSize: number | null;
  // "MM/YYYY", the listing's earliest date, or null.
  expiration: string | null;
  condition: string | null;
};

// Bin, shelf, box and dud box labels: just the barcode and a big readable
// caption.
export type CodeLabelPayload = {
  code: string;
  caption?: string;
};

// dud = a dud box label (DB0001), caption = the manifest it belongs to.
// sort = a sort box label (SB0001); reused load to load, so no manifest on it.
export type PrintJobKind = "item" | "bin" | "shelf" | "box" | "dud" | "sort";

export type PrintJobPayload = ItemLabelPayload | CodeLabelPayload;

// Whole 4x6 pages rather than 2x1 labels: they only go to the station
// marked for packing slips (its PC's default printer is a 4x6 Rollo). The
// html is the complete printable page; code is what the station's log shows.
export const PAGE_JOB_KINDS = ["packing_slip", "delivery_label", "shipping_label"] as const;
export type PageJobKind = (typeof PAGE_JOB_KINDS)[number];
// order: which order a packing slip is for, so Reprint can build it again
// with the buyer's address (stripped from the saved copy once it prints).
export type PageJobPayload = { code: string; html: string; order?: { channel: "ebay" | "shopify"; orderId: string } };

export function isPageKind(v: unknown): v is PageJobKind {
  return (PAGE_JOB_KINDS as readonly unknown[]).includes(v);
}

// GET /api/stations/{id}. online = the station page checked in recently.
// weightOz is the latest scale reading (null = no scale reading yet);
// weightStable = the Dymo said the reading had settled.
export type StationStatus = {
  id: string;
  name: string;
  online: boolean;
  weightOz: number | null;
  weightStable: boolean;
  weightAt: string | null;
  // Packing slips and local delivery labels print here.
  packingSlips: boolean;
  // The print helper on this station's PC (printHelper.ts): the printers it
  // reported, the one picked for 4x6 pages, and whether it's running now.
  // helperActive = online with a printer picked: it prints the 4x6 pages,
  // the station page only the small code labels.
  printers: string[];
  printerName: string | null;
  helperOnline: boolean;
  helperSeenAt: string | null;
  helperActive: boolean;
  // Print automatically off: nothing is handed out to print.
  printPaused: boolean;
};

// One place an item's units physically are.
export type BinLocation = {
  binCode: string;
  shelfLabel: string | null;
  units: number;
};

export type ItemLocation = {
  bins: BinLocation[];
  // Item.shelfLocation for items listed before warehouse mode (no bins).
  legacyShelf: string | null;
};
