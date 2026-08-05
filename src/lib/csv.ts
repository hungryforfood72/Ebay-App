// eBay File Exchange "Create Listings" (Add) format, matched to the real
// template Cristian downloaded from Seller Hub — not a guess. Shipping,
// returns, and payment are handled via Business Policies (see
// references/ebay-shipping-setup.md) rather than the individual inline
// Shipping*/Returns* columns, which are intentionally left blank.
const HEADERS = [
  "Action(SiteID=US|Country=US|Currency=USD|Version=1193|CC=UTF-8)",
  "CustomLabel",
  "Category",
  "StoreCategory",
  "Title",
  "Subtitle",
  "Relationship",
  "RelationshipDetails",
  "ConditionID",
  "C:Brand",
  "C:Style",
  "C:MPN",
  "C:California Prop 65 Warning",
  "C:Country/Region of Manufacture",
  "C:Unit Quantity",
  "C:Unit Type",
  "PicURL",
  "Description",
  "Format",
  "Duration",
  "StartPrice",
  "BuyItNowPrice",
  "Quantity",
  "ImmediatePayRequired",
  "Location",
  "ShippingType",
  "ShippingService-1:Option",
  "ShippingService-1:Cost",
  "ShippingService-2:Option",
  "ShippingService-2:Cost",
  "DispatchTimeMax",
  "PromotionalShippingDiscount",
  "ShippingDiscountProfileID",
  "ReturnsAcceptedOption",
  "ReturnsWithinOption",
  "RefundOption",
  "ShippingCostPaidByOption",
  "AdditionalDetails",
  "ShippingProfileName",
  "ReturnProfileName",
  "PaymentProfileName",
  "C:UPC",
  "C:Color",
  "C:Type",
  "C:Item Length",
  "C:Item Width",
  "C:Item Height",
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
  const shippingCalculated = process.env.EBAY_SHIPPING_POLICY_CALCULATED ?? "";
  const returnPolicy = process.env.EBAY_RETURN_POLICY_NAME ?? "";
  const paymentPolicy = process.env.EBAY_PAYMENT_POLICY_NAME ?? "";
  const zip = process.env.EBAY_LISTING_ZIP ?? "60620";

  const rows = items.map((item) => {
    const specifics = (item.itemSpecifics as Record<string, string> | null) ?? {};

    const fields: Record<(typeof HEADERS)[number], string> = {
      "Action(SiteID=US|Country=US|Currency=USD|Version=1193|CC=UTF-8)": "Add",
      CustomLabel: item.sku,
      Category: item.categoryId ?? "",
      StoreCategory: "",
      Title: item.finalTitle ?? "",
      Subtitle: "",
      Relationship: "",
      RelationshipDetails: "",
      ConditionID: item.condition ? CONDITION_ID[item.condition] ?? "" : "",
      "C:Brand": specifics.brand ?? "Unbranded",
      "C:Style": "",
      "C:MPN": "",
      "C:California Prop 65 Warning": "",
      "C:Country/Region of Manufacture": "",
      "C:Unit Quantity": item.isMultipack && item.packSize ? String(item.packSize) : "",
      "C:Unit Type": item.isMultipack ? "Pack" : "",
      PicURL: item.photoUrls.join("|"),
      Description: item.finalDescription ?? "",
      Format: "FixedPrice",
      Duration: "GTC",
      StartPrice: item.price != null ? String(item.price) : "",
      BuyItNowPrice: "",
      Quantity: String(item.quantity),
      ImmediatePayRequired: "Yes",
      Location: zip,
      ShippingType: "",
      "ShippingService-1:Option": "",
      "ShippingService-1:Cost": "",
      "ShippingService-2:Option": "",
      "ShippingService-2:Cost": "",
      DispatchTimeMax: "",
      PromotionalShippingDiscount: "",
      ShippingDiscountProfileID: "",
      ReturnsAcceptedOption: "",
      ReturnsWithinOption: "",
      RefundOption: "",
      ShippingCostPaidByOption: "",
      AdditionalDetails: "",
      ShippingProfileName: item.chargeForShipping ? shippingCalculated : shippingFree,
      ReturnProfileName: returnPolicy,
      PaymentProfileName: paymentPolicy,
      "C:UPC": item.upc,
      "C:Color": specifics.color ?? "",
      "C:Type": specifics.type ?? "",
      "C:Item Length": "",
      "C:Item Width": "",
      "C:Item Height": "",
      "C:Item Weight": formatWeight(item.weightLbs, item.weightOz),
    };
    return HEADERS.map((h) => escapeCsvField(fields[h])).join(",");
  });

  return [HEADERS.join(","), ...rows].join("\r\n");
}
