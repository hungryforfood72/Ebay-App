import { logActivity } from "../activityLog";
import { endFixedPriceItem, withdrawOffer } from "../ebay";
import { prisma } from "../prisma";
import { lineKey } from "../upcMatch";
import { WarehouseError } from "./bins";

// Taking down a listing because the package says "Rx Only" (Cristian,
// 2026-10-25: eBay removed a Bard leg bag listing under its prescription
// policy). The listing ends on eBay (the Shopify copy follows on the next
// sync, since it's no longer live), the item goes on the Dashboard's pull
// list with the reason (pullReason "rx_return", so staff pull it from its
// bins), and on a consignment load its units are logged as going back to
// the supplier. Its remaining units stop counting as listed (quantity drops
// to what sold), so they're counted once, as returned. Server only.

export const RX_RETURN_REASON = "rx_return";
// ConsignmentReturnEntry.reason for these, next to "leave" and
// "not_on_manifest".
export const RX_ONLY_RETURN = "rx_only";

export async function returnRxItem(itemId: string, by: string | null): Promise<{ sku: string; units: number; toSupplier: boolean }> {
  const item = await prisma.item.findUnique({
    where: { id: itemId },
    include: { manifest: { select: { consignment: true } } },
  });
  if (!item) throw new WarehouseError("Item not found.", 404);
  if (item.status !== "listed" && item.status !== "exported") {
    throw new WarehouseError(`${item.sku} isn't live (it's ${item.status}).`);
  }
  if (item.isBundle) throw new WarehouseError("Bundles can't be sent back this way; end it and split it up by hand.");

  if (item.ebayOfferId) await withdrawOffer(item.ebayOfferId);
  else if (item.ebayListingId) await endFixedPriceItem(item.ebayListingId);

  const left = Math.max(0, item.quantity - item.soldQuantity);
  const units = left * (item.isMultipack && item.packSize ? item.packSize : 1);
  // The product as the manifest knows it: its UPC, or for a no-UPC product
  // picked by name or Item #, its line key.
  const line = item.manifestLineId
    ? await prisma.manifestLine.findUnique({ where: { id: item.manifestLineId }, select: { id: true, upc: true, supplierSku: true, description: true } })
    : null;
  const productKey = item.upc ?? (line ? lineKey(line) : null);
  const toSupplier = Boolean(item.manifest?.consignment && item.manifestId && productKey && units > 0);
  const now = new Date();

  await prisma.$transaction([
    prisma.item.update({
      where: { id: item.id },
      data: {
        status: "expired",
        expiredAt: now,
        pullReason: RX_RETURN_REASON,
        listingEndedAt: item.ebayOfferId || item.ebayListingId ? now : null,
        quantity: item.soldQuantity,
        ebayEndError: null,
      },
    }),
    ...(toSupplier
      ? [
          prisma.consignmentReturnEntry.create({
            data: {
              manifestId: item.manifestId!,
              upc: productKey!,
              description: line?.description ?? item.finalTitle ?? item.sku,
              quantity: units,
              reason: RX_ONLY_RETURN,
              recordedBy: by,
            },
          }),
        ]
      : []),
  ]);
  await logActivity(
    { username: by },
    {
      action: "end",
      summary: `${item.sku}: ended (package says Rx Only), ${units} unit${units === 1 ? "" : "s"} ${toSupplier ? "going back to the supplier" : "to pull"}`,
      targetType: "item",
      targetId: item.id,
      before: { status: item.status, quantity: item.quantity },
      after: { status: "expired", quantity: item.soldQuantity, pullReason: RX_RETURN_REASON },
    }
  );
  return { sku: item.sku, units, toSupplier };
}
