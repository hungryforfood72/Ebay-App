import type { Prisma } from "@/generated/prisma/client";
import { prisma } from "../prisma";
import { WarehouseError } from "./bins";
import { BOX_CODE_PREFIX, classifyScan, codeNumber, formatBoxCode, normalizeCode } from "./codes";

// Box sizes with warehouse-mode extras: a barcode (BX001) the lister scans
// at the station, the empty box's weight (added to the scale reading), and
// inside dimensions. Server only; the BoxSizeDto type is safe to import
// with `import type` anywhere.
//
// Codes are unique, but the DB can't enforce it (the column was added
// without a unique index), so every write that sets a code goes through
// this file under one advisory lock.

type Tx = Prisma.TransactionClient;

// GET /api/box-sizes returns a list of these. id/label are what the scan
// and review pages always used; the rest is new and null for boxes nobody
// has filled in yet.
export type BoxSizeDto = {
  id: string;
  label: string;
  code: string | null;
  tareOz: number | null;
  lengthIn: number | null;
  widthIn: number | null;
  heightIn: number | null;
  createdAt: string;
};

type Dec = { toNumber(): number } | null;

export function toBoxSizeDto(b: {
  id: string;
  label: string;
  code: string | null;
  tareOz: Dec;
  lengthIn: Dec;
  widthIn: Dec;
  heightIn: Dec;
  createdAt: Date;
}): BoxSizeDto {
  return {
    id: b.id,
    label: b.label,
    code: b.code,
    tareOz: b.tareOz?.toNumber() ?? null,
    lengthIn: b.lengthIn?.toNumber() ?? null,
    widthIn: b.widthIn?.toNumber() ?? null,
    heightIn: b.heightIn?.toNumber() ?? null,
    createdAt: b.createdAt.toISOString(),
  };
}

async function lockBoxCodes(tx: Tx) {
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext('warehouse_box_codes'))`;
}

// Next free BXnnn, numerically after the highest one in use.
async function nextBoxCode(tx: Tx): Promise<string> {
  const rows = await tx.boxSize.findMany({ where: { code: { not: null } }, select: { code: true } });
  const max = Math.max(0, ...rows.map((r) => codeNumber(r.code!, BOX_CODE_PREFIX) ?? 0));
  return formatBoxCode(max + 1);
}

// Gives every box without a code the next free one. Runs on GET, so boxes
// set up before warehouse mode get barcodes without anyone doing anything.
// Cheap when there's nothing to do (one count on a table of a dozen rows).
export async function backfillBoxCodes(): Promise<void> {
  const missing = await prisma.boxSize.count({ where: { code: null } });
  if (missing === 0) return;
  await prisma.$transaction(async (tx) => {
    await lockBoxCodes(tx);
    const boxes = await tx.boxSize.findMany({ where: { code: null }, orderBy: { createdAt: "asc" } });
    for (const box of boxes) {
      await tx.boxSize.update({ where: { id: box.id }, data: { code: await nextBoxCode(tx) } });
    }
  });
}

// A number field from the Settings form: blank = null, otherwise 0 or more
// and under `max` (the DB column's limit), rounded to 0.01.
function optionalNumber(raw: unknown, field: string, max: number): number | null {
  if (raw === null || raw === undefined || raw === "") return null;
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 0 || n >= max) throw new WarehouseError(`${field} must be a number from 0 to ${max - 1}.`);
  return Math.round(n * 100) / 100;
}

export type BoxSizeInput = {
  label?: unknown;
  code?: unknown;
  tareOz?: unknown;
  lengthIn?: unknown;
  widthIn?: unknown;
  heightIn?: unknown;
};

// Creates a box (id null) or updates one. Only fields present in `input`
// change on an update. A blank code on create gets the next BXnnn.
export async function saveBoxSize(id: string | null, input: BoxSizeInput): Promise<BoxSizeDto> {
  const data: Prisma.BoxSizeUpdateInput = {};
  if ("label" in input) {
    const label = String(input.label ?? "").trim();
    if (!label) throw new WarehouseError("Give the box a name.");
    if (label.length > 60) throw new WarehouseError("Keep the box name under 60 characters.");
    data.label = label;
  } else if (!id) {
    throw new WarehouseError("Give the box a name.");
  }
  if ("tareOz" in input) data.tareOz = optionalNumber(input.tareOz, "Empty box weight", 10000);
  if ("lengthIn" in input) data.lengthIn = optionalNumber(input.lengthIn, "Length", 1000);
  if ("widthIn" in input) data.widthIn = optionalNumber(input.widthIn, "Width", 1000);
  if ("heightIn" in input) data.heightIn = optionalNumber(input.heightIn, "Height", 1000);

  let code: string | null | undefined;
  if ("code" in input && input.code !== null && input.code !== undefined && String(input.code).trim() !== "") {
    code = normalizeCode(String(input.code));
    if (classifyScan(code) !== "box") {
      throw new WarehouseError("Box codes look like BX001: BX and at least 3 digits.");
    }
  }

  return prisma.$transaction(async (tx) => {
    await lockBoxCodes(tx);
    if (data.label) {
      const clash = await tx.boxSize.findFirst({
        where: { label: { equals: data.label as string, mode: "insensitive" }, ...(id ? { id: { not: id } } : {}) },
        select: { id: true },
      });
      if (clash) throw new WarehouseError(`There's already a box called "${data.label}".`, 409);
    }
    if (code) {
      const clash = await tx.boxSize.findFirst({
        where: { code, ...(id ? { id: { not: id } } : {}) },
        select: { label: true },
      });
      if (clash) throw new WarehouseError(`${code} is already used by "${clash.label}".`, 409);
      data.code = code;
    } else if (!id) {
      data.code = await nextBoxCode(tx);
    }

    const row = id
      ? await tx.boxSize.update({ where: { id }, data })
      : await tx.boxSize.create({ data: data as Prisma.BoxSizeCreateInput });
    return toBoxSizeDto(row);
  });
}
