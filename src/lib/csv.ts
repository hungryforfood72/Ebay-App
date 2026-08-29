import { truncateTitle } from "@/lib/ebayTitle";
import { formatExpiration } from "@/lib/formatExpiration";

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
  "C:Expiration Date",
  "C:Dosage",
  "C:Size",
  "C:Department",
  "C:Size Type",
  "C:Volume",
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
  expirationDate: Date | string | null;
  bundleComponents: unknown;
};

// Bundles never set their own top-level expirationDate — only individual
// components do (different items in the same bundle can expire on
// different dates, or not at all) — so a bundle in a category that
// requires "Expiration Date" needs one derived from its components. Using
// the earliest is the more conservative disclosure to the buyer.
function earliestBundleExpiration(bundleComponents: unknown): string | null {
  const components = (bundleComponents as { expirationDate?: string | null }[] | null) ?? [];
  const dates = components.map((c) => c.expirationDate).filter((d): d is string => Boolean(d));
  if (dates.length === 0) return null;
  return dates.reduce((earliest, d) => (new Date(d) < new Date(earliest) ? d : earliest));
}

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

// eBay rejects WeightMinor outside 0-15 ("Invalid value provided for Weight
// Minor" on a real upload for 2 lb 16 oz, which is really just 3 lb 0 oz) —
// carry ounces over 15 into pounds rather than trust whatever was entered.
function normalizeWeight(lbs: number | null, oz: number | null): { lbs: number; oz: number } {
  const totalOz = (lbs ?? 0) * 16 + (oz ?? 0);
  return { lbs: Math.floor(totalOz / 16), oz: totalOz % 16 };
}

export function itemsToFileExchangeCsv(items: ExportableItem[]): string {
  const shippingFree = process.env.EBAY_SHIPPING_POLICY_FREE ?? "";
  const returnPolicy = process.env.EBAY_RETURN_POLICY_NAME ?? "";
  const paymentPolicy = process.env.EBAY_PAYMENT_POLICY_NAME ?? "";
  const zip = process.env.EBAY_LISTING_ZIP ?? "60620";

  const rows = items.map((item) => {
    const specifics = (item.itemSpecifics as Record<string, string> | null) ?? {};
    const weight = normalizeWeight(item.weightLbs, item.weightOz);
    const expirationDate = item.expirationDate ?? earliestBundleExpiration(item.bundleComponents);

    const fields: Record<(typeof HEADERS)[number], string> = {
      "Action(SiteID=US|Country=US|Currency=USD|Version=1193|CC=UTF-8)": "Add",
      CustomLabel: item.sku,
      Category: item.categoryId ?? "",
      Title: item.finalTitle ? truncateTitle(item.finalTitle) : "",
      ConditionID: item.condition ? CONDITION_ID[item.condition] ?? "" : "",
      "C:Brand": specifics.brand ?? "Unbranded",
      "C:Unit Quantity": item.isMultipack && item.packSize ? String(item.packSize) : "",
      "C:Unit Type": item.isMultipack ? "Pack" : "",
      // eBay caps listings at 24 photos — a bundle with several
      // multi-photo components could exceed that, so trim rather than
      // risk an upload error over it.
      PicURL: item.photoUrls.slice(0, 24).join("|"),
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
      WeightMajor: String(weight.lbs),
      WeightMinor: String(weight.oz),
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
      "C:Item Weight": formatWeight(weight.lbs, weight.oz),
      // Some categories (OTC medicine, vitamins/supplements) require these
      // as real item specifics, not just text worked into the title/
      // description — a real upload failed with "The item specific
      // Expiration Date/Dosage is missing" for exactly that reason.
      "C:Expiration Date": expirationDate ? formatExpiration(expirationDate) : "",
      // eBay caps Dosage at 65 characters ("value is too long" on a real
      // upload for a 3-ingredient combo dosage string) — reuse truncateTitle's
      // word-boundary truncation logic, it's generic and not title-specific.
      "C:Dosage": truncateTitle(specifics.dosage ?? specifics.size ?? "", 65),
      // Clothing categories require these as real item specifics — a real
      // upload failed with "item specific Size/Department/Size Type is
      // missing" for a t-shirt listing that only had Size worked into
      // specifics.size, with nothing for Department or Size Type at all.
      "C:Size": specifics.size ?? "",
      "C:Department": specifics.department ?? "",
      "C:Size Type": specifics.sizeType ?? "",
      "C:Volume": specifics.volume ?? "",
    };
    return HEADERS.map((h) => escapeCsvField(fields[h])).join(",");
  });

  return [HEADERS.join(","), ...rows].join("\r\n");
}
