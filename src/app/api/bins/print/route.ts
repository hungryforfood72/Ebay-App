import type { Prisma } from "@/generated/prisma/client";
import { getRequestUser, requireUser } from "@/lib/auth";
import { naturalSort } from "@/lib/naturalSort";
import { prisma } from "@/lib/prisma";
import { WarehouseError } from "@/lib/warehouse/bins";
import { BIN_CODE_PREFIX, codeNumber, normalizeCode } from "@/lib/warehouse/codes";
import type { CodeLabelPayload } from "@/lib/warehouse/types";
import { NextRequest, NextResponse } from "next/server";
import { binsErrorResponse, readCode } from "../shared";

const MAX_LABELS = 500;

// Queues bin or shelf labels at a station PC, which prints them on its
// Rollo (the station page polls for queued jobs).
//   { stationId, kind: "bin", fromCode, toCode, copies? }   a range of bins
//   { stationId, kind: "bin" | "shelf", codes: [...], copies? }
//   { stationId, kind: "shelf", allShelves: true, copies? }
// -> { queued, codes }.
// Anyone can reprint one torn label; printing a batch is owner only, same
// as making bins.
export async function POST(request: NextRequest) {
  const body = await request.json().catch(() => ({}));
  const stationId = readCode(body.stationId);
  const kind = body.kind === "bin" || body.kind === "shelf" ? body.kind : null;
  const copies = body.copies == null ? 1 : Number(body.copies);
  if (!stationId) return NextResponse.json({ error: "Pick a station to print at." }, { status: 400 });
  if (!kind) return NextResponse.json({ error: "Send kind: bin or shelf." }, { status: 400 });
  if (!Number.isInteger(copies) || copies < 1 || copies > 20) {
    return NextResponse.json({ error: "Copies must be between 1 and 20." }, { status: 400 });
  }

  try {
    const user = requireUser(request);
    let codes: string[];
    if (kind === "bin") {
      codes = await binCodes(body);
    } else {
      codes = await shelfCodes(body);
    }
    if (codes.length === 0) throw new WarehouseError("Nothing to print.");
    if (codes.length > MAX_LABELS) throw new WarehouseError(`That's ${codes.length} labels. Print ${MAX_LABELS} or fewer at a time.`);
    if (codes.length > 1 && user.role !== "owner") {
      throw new WarehouseError("Only the owner can print a batch of labels. You can reprint one at a time.", 403);
    }

    const station = await prisma.station.findUnique({ where: { id: stationId }, select: { id: true } });
    if (!station) throw new WarehouseError("That station doesn't exist anymore. Pick a station again.", 404);
    // One job per label so the station prints them in order and a failed
    // one can be retried alone. createMany instead of queuePrintJob in a
    // loop: hundreds of one-row inserts would be slow over the network.
    const by = getRequestUser(request)?.username ?? null;
    await prisma.printJob.createMany({
      data: codes.map((code) => ({
        stationId,
        kind,
        payload: { code } satisfies CodeLabelPayload as Prisma.InputJsonValue,
        copies,
        createdBy: by,
      })),
    });
    return NextResponse.json({ queued: codes.length, codes }, { status: 201 });
  } catch (e) {
    return binsErrorResponse(e);
  }
}

// Bins that exist, from an explicit list or a number range (BN0001 to
// BN0050, ends included, in number order).
async function binCodes(body: Record<string, unknown>): Promise<string[]> {
  if (Array.isArray(body.codes)) {
    const wanted = [...new Set(body.codes.filter((c): c is string => typeof c === "string").map(normalizeCode))];
    const found = await prisma.bin.findMany({ where: { code: { in: wanted } }, select: { code: true } });
    const missing = wanted.filter((c) => !found.some((b) => b.code === c));
    if (missing.length) throw new WarehouseError(`No bin with code ${missing.slice(0, 5).join(", ")}.`, 404);
    return sortBins(wanted);
  }
  const from = codeNumber(readCode(body.fromCode), BIN_CODE_PREFIX) ?? Number(body.fromCode);
  const to = codeNumber(readCode(body.toCode), BIN_CODE_PREFIX) ?? Number(body.toCode);
  if (!Number.isInteger(from) || !Number.isInteger(to) || from < 1 || to < from) {
    throw new WarehouseError("Enter a bin range like BN0001 to BN0050.");
  }
  if (to - from + 1 > MAX_LABELS) throw new WarehouseError(`Print ${MAX_LABELS} or fewer at a time.`);
  const all = await prisma.bin.findMany({ select: { code: true } });
  const inRange = all
    .map((b) => b.code)
    .filter((c) => {
      const n = codeNumber(c, BIN_CODE_PREFIX);
      return n != null && n >= from && n <= to;
    });
  if (inRange.length === 0) throw new WarehouseError("No bins in that range yet. Make them first.");
  return sortBins(inRange);
}

function sortBins(codes: string[]): string[] {
  return [...codes].sort((a, b) => (codeNumber(a, BIN_CODE_PREFIX) ?? 0) - (codeNumber(b, BIN_CODE_PREFIX) ?? 0));
}

// Shelf labels from ShelfLocation, printed exactly as stored so the scan
// matches the shelf.
async function shelfCodes(body: Record<string, unknown>): Promise<string[]> {
  const shelves = await prisma.shelfLocation.findMany({ select: { label: true } });
  if (body.allShelves === true) return naturalSort(shelves, (s) => s.label).map((s) => s.label);
  if (!Array.isArray(body.codes)) throw new WarehouseError("Pick the shelves to print.");
  const out: string[] = [];
  for (const raw of body.codes) {
    if (typeof raw !== "string" || !raw.trim()) continue;
    const shelf = shelves.find((s) => s.label.toLowerCase() === raw.trim().toLowerCase());
    if (!shelf) throw new WarehouseError(`No shelf called "${raw.trim()}". Add it in Settings first.`, 404);
    if (!out.includes(shelf.label)) out.push(shelf.label);
  }
  return out;
}
