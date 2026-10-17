import { getRequestUser } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { findBin, shelveBin, WarehouseError } from "@/lib/warehouse/bins";
import { NextRequest, NextResponse } from "next/server";
import { binsErrorResponse, readCode, summarizeBins } from "../shared";

// Puts a bin on a shelf: { binCode, shelfLabel } -> { bin, previousShelf }.
// Moving a bin that's already on another shelf just re-points it (last
// scan wins if two people shelve the same bin at once, which matches
// where it physically ended up).
export async function POST(request: NextRequest) {
  const body = await request.json().catch(() => ({}));
  const binCode = readCode(body.binCode);
  const shelfLabel = readCode(body.shelfLabel);
  if (!binCode) return NextResponse.json({ error: "Scan a bin first." }, { status: 400 });
  if (!shelfLabel) return NextResponse.json({ error: "Scan a shelf first." }, { status: 400 });
  try {
    const bin = await findBin(prisma, binCode);
    // An empty bin on a shelf only shows up later as "go grab this for
    // reuse", so don't let one get shelved in the first place.
    const items = await prisma.binContent.count({ where: { binId: bin.id } });
    if (items === 0) throw new WarehouseError(`${bin.code} is empty. Fill it before shelving it.`);
    await shelveBin({ binCode: bin.code, shelfLabel, by: getRequestUser(request)?.username ?? null });
    const [summary] = await summarizeBins({ id: bin.id });
    return NextResponse.json({ bin: summary, previousShelf: bin.shelfLabel });
  } catch (e) {
    return binsErrorResponse(e);
  }
}
