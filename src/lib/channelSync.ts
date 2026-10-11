import { syncEbayOrders, type EbayOrderSyncResult } from "./ebayOrderSync";
import { runShopifySync, type ShopifySyncResult } from "./shopifySync";
import { withSyncLock } from "./syncLock";

export type EbaySalesSyncResult = {
  // false when another eBay sync was already running; it was asked to run
  // again when it finishes, so this call's sale gets picked up there.
  ran: boolean;
  ebay: EbayOrderSyncResult[];
  shopify: ShopifySyncResult | null;
};

// Every eBay order sync goes through here (cron, sale alert, the manual
// button), so two can never overlap, and Shopify hears about every eBay
// sale in the same breath. `orderIds`: orders to fetch directly, for a
// sale alert naming an order eBay's order search may not show yet.
export async function syncEbaySales(mode: "quick" | "full", orderIds: string[] = []): Promise<EbaySalesSyncResult> {
  let first = true;
  const locked = await withSyncLock("ebay-orders", mode, (m) => {
    const ids = first ? orderIds : [];
    first = false;
    return syncEbayOrders({ quick: m !== "full", ...(ids.length ? { orderIds: ids } : {}) });
  });
  if (!locked.ran) return { ran: false, ebay: [], shopify: null };
  const changed = [...new Set(locked.results.flatMap((r) => r.changedItemIds))];
  const shopify = changed.length > 0 ? await runShopifySync({ items: changed }) : null;
  return { ran: true, ebay: locked.results, shopify };
}
