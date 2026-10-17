import type { Prisma } from "@/generated/prisma/client";
import { prisma } from "../prisma";
import { WarehouseError } from "./bins";
import type { PrintJobKind, PrintJobPayload } from "./types";

// Queues labels for a station PC to print. The station page (/station/{id})
// polls for queued jobs and prints them on its Rollo.
export async function queuePrintJob(
  args: {
    stationId: string;
    kind: PrintJobKind;
    payload: PrintJobPayload;
    copies?: number;
    by: string | null;
  },
  tx: Prisma.TransactionClient | typeof prisma = prisma
) {
  const copies = args.copies ?? 1;
  if (!Number.isInteger(copies) || copies < 1 || copies > 200) {
    throw new WarehouseError("Copies must be between 1 and 200.");
  }
  const station = await tx.station.findUnique({ where: { id: args.stationId }, select: { id: true } });
  if (!station) throw new WarehouseError("That station doesn't exist anymore. Pick a station again.", 404);
  return tx.printJob.create({
    data: {
      stationId: args.stationId,
      kind: args.kind,
      payload: args.payload as Prisma.InputJsonValue,
      copies,
      createdBy: args.by,
    },
  });
}
