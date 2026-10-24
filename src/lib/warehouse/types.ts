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

// The label stock a station's small code labels print on, picked on the
// station page (Cristian, 2026-10-24: bin labels on 2.25" x 1.25"). The
// label is laid out for 2" x 1" and grows to fill bigger stock. Inches,
// width across the printer first.
export const LABEL_SIZES = {
  "2x1": { width: 2, height: 1, name: '2" x 1"' },
  "2.25x1.25": { width: 2.25, height: 1.25, name: '2.25" x 1.25"' },
  "4x6": { width: 4, height: 6, name: '4" x 6"' },
} as const;
export type LabelSize = keyof typeof LABEL_SIZES;
export const DEFAULT_LABEL_SIZE: LabelSize = "2x1";

export function isLabelSize(v: unknown): v is LabelSize {
  return typeof v === "string" && Object.hasOwn(LABEL_SIZES, v);
}

export function labelSizeOf(v: unknown): LabelSize {
  return isLabelSize(v) ? v : DEFAULT_LABEL_SIZE;
}

// The first print helper (VERSION in public/print-helper/print_helper.py;
// its dates compare as strings) that prints the small labels at a picked
// size and takes "Check for updates". An older one would print small
// labels on its 4x6 printer, so it doesn't get them until it has updated
// (every 6h, a restart, or Reinstall). Later versions only need to be
// greater; this stays the first one with the feature.
export const LABEL_HELPER_VERSION = "2026-10-24.1";

export function helperCanPrintLabels(version: string | null): boolean {
  return version != null && version >= LABEL_HELPER_VERSION;
}

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
  // The version the helper last checked in with, and "Check for updates"
  // was pressed and the helper hasn't picked that up yet.
  helperVersion: string | null;
  helperUpdatePending: boolean;
  // The small code labels: the stock they print on, and the printer the
  // helper prints them on (null = the station page, on the Windows
  // default). helperLabelsActive = the helper is online, new enough, and
  // has a label printer: it prints them, not the page.
  labelSize: LabelSize;
  labelPrinterName: string | null;
  helperLabelsActive: boolean;
  // Which jobs the helper takes, so the station page leaves them alone:
  // decided by the printers picked, NOT by whether the helper checked in
  // lately. When the page took over whenever the helper looked offline,
  // a long batch of bin labels went quiet past the online window and the
  // page printed the rest on the Windows default printer, sideways on 4x6
  // (Cristian, 2026-10-24). If the helper is really down, they wait.
  helperTakesPages: boolean;
  helperTakesLabels: boolean;
  // Print automatically off: nothing is handed out to print.
  printPaused: boolean;
};

// One place an item's units physically are.
export type BinLocation = {
  binCode: string;
  shelfLabel: string | null;
  units: number;
  // Straight on an oversized shelf (its hidden shelf bin), not in a bin.
  oversized?: boolean;
};

export type ItemLocation = {
  bins: BinLocation[];
  // Item.shelfLocation for items listed before warehouse mode (no bins).
  legacyShelf: string | null;
};
