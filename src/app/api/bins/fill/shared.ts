import type { Prisma } from "@/generated/prisma/client";
import { findBin, lockBins, WarehouseError } from "@/lib/warehouse/bins";

// Rules for the binning station's open bin, shared by its routes.

type Tx = Prisma.TransactionClient;

// A bin can be filled when it's empty (even if still marked on a shelf:
// the first unit takes it off, see placeInBin), or open/closed and not on
// a shelf. A bin with items on a shelf has to come off the shelf first, so
// the app never thinks units are on a shelf that are really at the station.
// Filling a closed bin reopens it. Returns the bin and whether it was
// closed before.
export async function openForFilling(tx: Tx, binCode: string) {
  // The bin's lock first (the lock order in bins.ts): one change to this
  // bin at a time, so a second scan or a combine waits here.
  await lockBins(tx, [binCode]);
  const bin = await findBin(tx, binCode);
  const fresh = await tx.bin.findUniqueOrThrow({ where: { id: bin.id } });
  const items = await tx.binContent.count({ where: { binId: bin.id } });
  if (items > 0 && fresh.shelfLabel) {
    throw new WarehouseError(
      `${fresh.code} is on shelf ${fresh.shelfLabel} with items in it. Take it off the shelf first (Look up, then Take off shelf).`,
      409
    );
  }
  const wasClosed = Boolean(fresh.closedAt) && items > 0;
  if (fresh.closedAt) await tx.bin.update({ where: { id: bin.id }, data: { closedAt: null, closedBy: null } });
  return { bin: fresh, items, wasClosed };
}
