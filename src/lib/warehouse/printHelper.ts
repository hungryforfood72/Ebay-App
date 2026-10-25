import { randomBytes } from "node:crypto";
import { prisma } from "../prisma";
import { WarehouseError } from "./bins";
import { STATION_ONLINE_MS } from "./settings";
import { helperCanPrintLabels } from "./types";

// The print helper (Cristian, 2026-10-21): a small Python program on a
// station PC (public/print-helper/print_helper.py) that prints the 4x6
// pages on a printer picked on the station page, whatever the Windows
// default is (Chrome's silent printing can only use the default, and
// drifts to the last printer it used). Installed by a one-file installer
// downloaded from the station page; that file carries the station's key,
// so there's no login to type. The helper only reaches
// /api/print-helper/* (proxy.ts lets those through signed-out) with
// "Authorization: Bearer <key>", and only ever sees its own station's jobs.
// Server only.

export const HELPER_TOKEN_PATTERN = /^[A-Za-z0-9_-]{32}$/;

export function newHelperToken(): string {
  return randomBytes(24).toString("base64url");
}

export function helperOnline(seenAt: Date | null, now = Date.now()): boolean {
  return seenAt != null && now - seenAt.getTime() <= STATION_ONLINE_MS;
}

// The helper prints this station's small code labels, not the page.
export function helperPrintsLabels(
  s: { helperSeenAt: Date | null; helperVersion: string | null; labelPrinterName: string | null },
  now = Date.now()
): boolean {
  return helperOnline(s.helperSeenAt, now) && s.labelPrinterName != null && helperCanPrintLabels(s.helperVersion);
}

// The station a helper request is for, by its key.
export async function stationForHelper(request: Request) {
  const token = request.headers.get("authorization")?.replace(/^Bearer\s+/i, "").trim() ?? "";
  if (!HELPER_TOKEN_PATTERN.test(token)) throw new WarehouseError("Missing print helper key.", 401);
  const station = await prisma.station.findFirst({ where: { helperToken: token } });
  if (!station) throw new WarehouseError("This print helper's key isn't valid anymore. Download the installer again.", 401);
  return station;
}

// The station's key, made the first time an installer is downloaded.
// Downloading again reuses it, so a reinstall doesn't cut off a helper
// that's already running.
export async function helperTokenFor(stationId: string): Promise<{ token: string; name: string; slipPrinter: boolean }> {
  const station = await prisma.station.findUnique({
    where: { id: stationId },
    select: { helperToken: true, name: true, slipPrinter: true },
  });
  if (!station) throw new WarehouseError("That station doesn't exist anymore.", 404);
  if (station.helperToken) return { token: station.helperToken, name: station.name, slipPrinter: station.slipPrinter };
  const token = newHelperToken();
  await prisma.station.update({ where: { id: stationId }, data: { helperToken: token } });
  return { token, name: station.name, slipPrinter: station.slipPrinter };
}

// The scale on the helper's PC (Cristian, 2026-10-25): the helper reads the
// DYMO over USB and reports { status, weightOz, stable } on every change and
// with each check-in. status is a ScaleStatus (scale.ts) or "none" (no scale
// on that PC, or the helper can't read USB scales).
const HELPER_SCALE_STATUSES = new Set([
  "none",
  "off",
  "fault",
  "zero",
  "moving",
  "stable",
  "under_zero",
  "over_weight",
  "needs_calibration",
  "needs_rezero",
]);

// The Station fields a scale report writes, or null if it isn't one. A
// slip printer station has no scale: its reports are dropped.
export function helperScaleData(scale: unknown, station: { slipPrinter: boolean }, now: Date) {
  if (station.slipPrinter || !scale || typeof scale !== "object") return null;
  const { status, weightOz, stable, note } = scale as Record<string, unknown>;
  if (typeof status !== "string" || !HELPER_SCALE_STATUSES.has(status)) return null;
  const oz = typeof weightOz === "number" && Number.isFinite(weightOz) && weightOz >= 0 && weightOz < 1_000_000 ? Math.round(weightOz * 100) / 100 : null;
  if (status === "none") return { scaleStatus: status, scaleSeenAt: now, scaleNote: typeof note === "string" ? note.slice(0, 1000) : null };
  return {
    scaleStatus: status,
    scaleSeenAt: now,
    scaleNote: null,
    weightOz: oz,
    weightStable: oz !== null && stable === true,
    weightAt: oz === null ? null : now,
  };
}

// The helper has the scale right now: the weight is its, not the page's.
export function helperHasScale(s: { scaleStatus: string | null; scaleSeenAt: Date | null }, now = Date.now()): boolean {
  return s.scaleStatus != null && s.scaleStatus !== "none" && helperOnline(s.scaleSeenAt, now);
}
