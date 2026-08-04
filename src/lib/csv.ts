// eBay File Exchange "Add" format. This covers the fields we need to add a
// fixed-price listing; the exact template Seller Hub expects can vary by
// category, so double check the header row against a template you download
// from Seller Hub before your first real upload.
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
};

const CONDITION_ID: Record<string, string> = {
  new: "1000",
  new_other: "1500",
  used: "3000",
  for_parts: "7000",
};

export function itemsToFileExchangeCsv(items: ExportableItem[]): string {
  const rows = items.map((item) => {
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
    };
    return HEADERS.map((h) => escapeCsvField(fields[h])).join(",");
  });

  return [HEADERS.join(","), ...rows].join("\r\n");
}
