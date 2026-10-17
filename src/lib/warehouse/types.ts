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
export type PrintJobKind = "item" | "bin" | "shelf" | "box" | "dud";

export type PrintJobPayload = ItemLabelPayload | CodeLabelPayload;

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
