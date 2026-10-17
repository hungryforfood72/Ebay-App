import { prisma } from "../prisma";

// Warehouse mode switch (Settings page). Off = the scan page works exactly
// as before (shelf location step, typed weight, "(Location - X)-uuid" sku).
// On = bins, labels, scale and the "ES000123" sku for new items. Items
// listed before it was turned on keep their shelf location and old sku.
const WAREHOUSE_MODE_KEY = "warehouse_mode";

export async function isWarehouseMode(): Promise<boolean> {
  const row = await prisma.appSetting.findUnique({ where: { key: WAREHOUSE_MODE_KEY } });
  return row?.value === "on";
}

export async function setWarehouseMode(on: boolean): Promise<void> {
  await prisma.appSetting.upsert({
    where: { key: WAREHOUSE_MODE_KEY },
    create: { key: WAREHOUSE_MODE_KEY, value: on ? "on" : "off" },
    update: { value: on ? "on" : "off" },
  });
}

// A station counts as online if its page checked in this recently. The
// station page sends a heartbeat at least every 10s.
export const STATION_ONLINE_MS = 30_000;
