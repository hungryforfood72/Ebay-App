import { helperOnline, helperPrintsLabels } from "./printHelper";
import { NextResponse } from "next/server";
import { AuthError } from "../auth";
import { WarehouseError } from "./bins";
import { STATION_ONLINE_MS } from "./settings";
import { labelSizeOf, type StationStatus } from "./types";

// Shared bits for the /api/stations and /api/print-jobs routes. Server only.

// The columns a StationStatus is built from. Routes select exactly these
// so the handhelds' weight poll stays one small query.
export const STATION_STATUS_SELECT = {
  id: true,
  name: true,
  weightOz: true,
  weightStable: true,
  weightAt: true,
  lastSeenAt: true,
  packingSlips: true,
  printers: true,
  printerName: true,
  helperSeenAt: true,
  helperVersion: true,
  helperUpdateAt: true,
  labelSize: true,
  labelPrinterName: true,
  printPaused: true,
} as const;

type StationRow = {
  id: string;
  name: string;
  weightOz: { toNumber(): number } | null;
  weightStable: boolean;
  weightAt: Date | null;
  lastSeenAt: Date | null;
  packingSlips: boolean;
  printers: string[];
  printerName: string | null;
  helperSeenAt: Date | null;
  helperVersion: string | null;
  helperUpdateAt: Date | null;
  labelSize: string;
  labelPrinterName: string | null;
  printPaused: boolean;
};

export function toStationStatus(row: StationRow, now = Date.now()): StationStatus {
  const online = row.lastSeenAt != null && now - row.lastSeenAt.getTime() <= STATION_ONLINE_MS;
  return {
    id: row.id,
    name: row.name,
    online,
    // An offline station's last reading is stale; don't let a handheld use
    // it as if it were on the scale right now.
    weightOz: online && row.weightOz != null ? row.weightOz.toNumber() : null,
    weightStable: online && row.weightStable,
    weightAt: row.weightAt ? row.weightAt.toISOString() : null,
    packingSlips: row.packingSlips,
    printers: row.printers,
    printerName: row.printerName,
    helperOnline: helperOnline(row.helperSeenAt, now),
    helperSeenAt: row.helperSeenAt?.toISOString() ?? null,
    helperActive: helperOnline(row.helperSeenAt, now) && row.printerName != null,
    helperVersion: row.helperVersion,
    helperUpdatePending: row.helperUpdateAt != null,
    labelSize: labelSizeOf(row.labelSize),
    labelPrinterName: row.labelPrinterName,
    helperLabelsActive: helperPrintsLabels(row, now),
    printPaused: row.printPaused,
  };
}

// The row a print log / jobs response shows for each PrintJob.
export type PrintJobRow = {
  id: string;
  kind: string;
  payload: unknown;
  copies: number;
  status: string;
  error: string | null;
  createdBy: string | null;
  createdAt: string;
  printedAt: string | null;
};

export function toPrintJobRow(j: {
  id: string;
  kind: string;
  payload: unknown;
  copies: number;
  status: string;
  error: string | null;
  createdBy: string | null;
  createdAt: Date;
  printedAt: Date | null;
}): PrintJobRow {
  return {
    id: j.id,
    kind: j.kind,
    payload: j.payload,
    copies: j.copies,
    status: j.status,
    error: j.error,
    createdBy: j.createdBy,
    createdAt: j.createdAt.toISOString(),
    printedAt: j.printedAt ? j.printedAt.toISOString() : null,
  };
}

// Turns the errors routes expect (bad input, not signed in, missing row)
// into a JSON response; anything else is a real bug and is rethrown.
export function errorResponse(e: unknown): NextResponse {
  if (e instanceof WarehouseError || e instanceof AuthError) {
    return NextResponse.json({ error: e.message }, { status: e.status });
  }
  const code = (e as { code?: string })?.code;
  if (code === "P2025") return NextResponse.json({ error: "Not found." }, { status: 404 });
  throw e;
}
