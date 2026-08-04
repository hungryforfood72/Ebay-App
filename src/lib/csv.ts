// eBay File Exchange "Add" format. This covers the fields we need to add a
// fixed-price listing; the exact template Seller Hub expects can vary by
// category, so double check the header row against a template you download
// from Seller Hub before your first real upload.
//
// Shipping/package columns below (ShippingService-1:Option, PackageSize,
// ExcludeShipToLocation) are my best-documented understanding, NOT verified
// against a live template — see references/ebay-shipping-setup.md before
// your first real shipping-enabled upload.
const HEADERS = [
  "Action",
  "SKU",
  "Category",
  "Title",
  "Description",
  "PicURL",
  "Quantity",
  "StartPrice",
  "ConditionID",
  "ShippingType",
  "ShippingService-1:Option",
  "ShippingService-1:Cost",
  "WeightMajor",
  "WeightMinor",
  "PackageSize",
  "ExcludeShipToLocation",
  "C:Brand",
  "C:Type",
  "C:Color",
  "C:Size",
  "C:Material",
] as const;

function escapeCsvField(value: string): string {
  if (/[",\n]/.test(value)) {
    return `"${value.replace(/"/g, '""')}"`;
  }
  return value;
}

export type ExportableItem = {
  sku: string;
  categoryId: string | null;
  finalTitle: string | null;
  finalDescription: string | null;
  photoUrls: string[];
  quantity: number;
  price: unknown;
  condition: string | null;
  itemSpecifics: unknown;
  chargeForShipping: boolean;
  boxSize: string | null;
  weightLbs: number | null;
  weightOz: number | null;
};

const CONDITION_ID: Record<string, string> = {
  new: "1000",
  new_other: "1500",
  used: "3000",
  for_parts: "7000",
};

// Store policy: never ship to Alaska or Hawaii. eBay's exact expected value
// for this column needs confirming against a real template — this is a
// best-effort guess at the conventional format.
const EXCLUDE_SHIP_TO_LOCATION = "Alaska,Hawaii";

export function itemsToFileExchangeCsv(items: ExportableItem[]): string {
  const rows = items.map((item) => {
    const specifics = (item.itemSpecifics as Record<string, string> | null) ?? {};

    const fields: Record<(typeof HEADERS)[number], string> = {
      Action: "Add",
      SKU: item.sku,
      Category: item.categoryId ?? "",
      Title: item.finalTitle ?? "",
      Description: item.finalDescription ?? "",
      PicURL: item.photoUrls.join("|"),
      Quantity: String(item.quantity),
      StartPrice: item.price != null ? String(item.price) : "",
      ConditionID: item.condition ? CONDITION_ID[item.condition] ?? "" : "",
      ShippingType: item.chargeForShipping ? "Calculated" : "Flat",
      "ShippingService-1:Option": "USPSGroundAdvantage",
      "ShippingService-1:Cost": item.chargeForShipping ? "" : "0.00",
      WeightMajor: item.weightLbs != null ? String(item.weightLbs) : "",
      WeightMinor: item.weightOz != null ? String(item.weightOz) : "",
      PackageSize: item.boxSize ?? "",
      ExcludeShipToLocation: EXCLUDE_SHIP_TO_LOCATION,
      "C:Brand": specifics.brand ?? "",
      "C:Type": specifics.type ?? "",
      "C:Color": specifics.color ?? "",
      "C:Size": specifics.size ?? "",
      "C:Material": specifics.material ?? "",
    };
    return HEADERS.map((h) => escapeCsvField(fields[h])).join(",");
  });

  return [HEADERS.join(","), ...rows].join("\r\n");
}
