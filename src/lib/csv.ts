// eBay File Exchange "Create Listings" (Add) format, matched to the real
// template Cristian downloaded from Seller Hub. Shipping, returns, and
// payment go through Business Policies (see
// references/ebay-shipping-setup.md) rather than the individual inline
// Shipping*/Returns* columns.
//
// Columns the template had but we never populate (StoreCategory, Subtitle,
// C:Style, C:MPN, ShippingType, individual ShippingService/Returns fields,
// etc.) are dropped entirely rather than left blank — eBay support's own
// guidance for spurious File Exchange errors is to delete unused template
// columns, not leave them empty. See references/ebay-shipping-setup.md for
// the real upload error this fixed and what's still unverified.
const HEADERS = [
  "Action(SiteID=US|Country=US|Currency=USD|Version=1193|CC=UTF-8)",
  "CustomLabel",
  "Category",
  "Title",
  "ConditionID",
  "C:Brand",
  "C:Unit Quantity",
  "C:Unit Type",
  "PicURL",
  "Description",
  "Format",
  "Duration",
  "StartPrice",
  "Quantity",
  "AutoPay",
  "Location",
  "ShippingProfileName",
  "ReturnProfileName",
  "PaymentProfileName",
  "C:UPC",
  "C:Color",
  "C:Type",
  "C:Item Weight",
] as const;

function escapeCsvField(value: string): string {
  if (/[",\n]/.test(value)) {
    return `"${value.replace(/"/g, '""')}"`;
  }
  return value;
}

export type ExportableItem = {
  sku: string;
  upc: string;
  categoryId: string | null;
  finalTitle: string | null;
  finalDescription: string | null;
  photoUrls: string[];
  quantity: number;
  price: unknown;
  condition: string | null;
  itemSpecifics: unknown;
  isMultipack: boolean;
  packSize: number | null;
  chargeForShipping: boolean;
  weightLbs: number | null;
  weightOz: number | null;
};

const CONDITION_ID: Record<string, string> = {
  new: "1000",
  new_other: "1500",
  used: "3000",
  for_parts: "7000",
};

function formatWeight(lbs: number | null, oz: number | null): string {
  if (lbs == null && oz == null) return "";
  const parts: string[] = [];
  if (lbs) parts.push(`${lbs} lb`);
  if (oz) parts.push(`${oz} oz`);
  return parts.join(" ");
}

export function itemsToFileExchangeCsv(items: ExportableItem[]): string {
  const shippingFree = process.env.EBAY_SHIPPING_POLICY_FREE ?? "";
  const returnPolicy = process.env.EBAY_RETURN_POLICY_NAME ?? "";
  const paymentPolicy = process.env.EBAY_PAYMENT_POLICY_NAME ?? "";
  const zip = process.env.EBAY_LISTING_ZIP ?? "60620";

  const rows = items.map((item) => {
    const specifics = (item.itemSpecifics as Record<string, string> | null) ?? {};

    const fields: Record<(typeof HEADERS)[number], string> = {
      "Action(SiteID=US|Country=US|Currency=USD|Version=1193|CC=UTF-8)": "Add",
      CustomLabel: item.sku,
      Category: item.categoryId ?? "",
      Title: item.finalTitle ?? "",
      ConditionID: item.condition ? CONDITION_ID[item.condition] ?? "" : "",
      "C:Brand": specifics.brand ?? "Unbranded",
      "C:Unit Quantity": item.isMultipack && item.packSize ? String(item.packSize) : "",
      "C:Unit Type": item.isMultipack ? "Pack" : "",
      PicURL: item.photoUrls.join("|"),
      Description: item.finalDescription ?? "",
      Format: "FixedPrice",
      Duration: "GTC",
      StartPrice: item.price != null ? String(item.price) : "",
      Quantity: String(item.quantity),
      // Managed Payments sellers use AutoPay=true, not ImmediatePayRequired
      // (that field threw "Item.AutoPay invalid or missing" on a real
      // upload — see references/ebay-shipping-setup.md).
      AutoPay: "true",
      Location: zip,
      // Everything's free shipping for now — kept item.chargeForShipping in
      // the data model in case that changes later, just not wired up here.
      ShippingProfileName: shippingFree,
      ReturnProfileName: returnPolicy,
      PaymentProfileName: paymentPolicy,
      "C:UPC": item.upc,
      "C:Color": specifics.color ?? "",
      "C:Type": specifics.type ?? "",
      "C:Item Weight": formatWeight(item.weightLbs, item.weightOz),
    };
    return HEADERS.map((h) => escapeCsvField(fields[h])).join(",");
  });

  return [HEADERS.join(","), ...rows].join("\r\n");
}
