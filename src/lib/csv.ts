import { truncateTitle } from "@/lib/ebayTitle";

// eBay File Exchange "Create Listings" (Add) format, matched to the real
// template Cristian downloaded from Seller Hub. Shipping, returns, and
// payment go through Business Policies (see
// references/ebay-shipping-setup.md) rather than the individual inline
// Shipping*/Returns* columns.
//
// Titles get a last-stop truncation to 80 chars right before export — see
// truncateTitle in ebayTitle.ts for why.
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
  "BestOfferEnabled",
  "PostalCode",
  "WeightMajor",
  "WeightMinor",
  "ShippingProfileName",
  "ReturnProfileName",
  "PaymentProfileName",
  "C:UPC",
  "C:Color",
  "C:Type",
  "C:Product",
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
  upc: string | null; // null for bundles — no single UPC applies
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
      Title: item.finalTitle ? truncateTitle(item.finalTitle) : "",
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
      // Fixed-price listings stay Buy It Now, but also accept offers —
      // Cristian reviews and accepts/declines/counters each one manually
      // in Seller Hub (no auto-accept/auto-decline thresholds set here).
      BestOfferEnabled: "true",
      // "Location" isn't a real postal code field — eBay rejected it with
      // "Please enter a valid postal code" on a real upload. PostalCode is
      // the actual field eBay validates against.
      PostalCode: zip,
      // eBay requires the actual package weight regardless of shipping
      // being free ("package weight is not valid or is missing" on a real
      // upload) — C:Item Weight alone is just a buyer-facing item specific,
      // not what eBay's shipping engine reads. Both must be whole numbers;
      // eBay expects both present even when one side is 0.
      WeightMajor: String(item.weightLbs ?? 0),
      WeightMinor: String(item.weightOz ?? 0),
      ShippingProfileName: shippingFree,
      ReturnProfileName: returnPolicy,
      PaymentProfileName: paymentPolicy,
      // Bundles have no single UPC — "Does Not Apply" is eBay's own
      // recognized value for "no identifier applies here", not just a
      // blank field (which can trigger a GTIN-required error in some
      // categories).
      "C:UPC": item.upc ?? "Does Not Apply",
      "C:Color": specifics.color ?? "",
      "C:Type": specifics.type ?? "",
      // Some categories require a literal "Product" item specific ("The
      // item specific Product is missing" on a real upload) — fall back to
      // the product type when the AI didn't give a distinct one.
      "C:Product": specifics.product ?? specifics.type ?? "",
      "C:Item Weight": formatWeight(item.weightLbs, item.weightOz),
    };
    return HEADERS.map((h) => escapeCsvField(fields[h])).join(",");
  });

  return [HEADERS.join(","), ...rows].join("\r\n");
}
