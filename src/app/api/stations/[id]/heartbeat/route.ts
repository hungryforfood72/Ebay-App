import { prisma } from "@/lib/prisma";
import { NextRequest, NextResponse } from "next/server";

// The station page checking in: its latest scale reading, and proof it's
// still open (lastSeenAt drives "online"). Sent on every weight change
// (at most ~4 a second) and every 10s otherwise.
//
// weightAt is stamped on every heartbeat that has a reading, not only when
// the number changes, so a handheld can tell "the scale still reads 30 oz"
// apart from "the scale went quiet a minute ago at 30 oz".
export async function POST(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const body = await request.json().catch(() => ({}));
  const weightOz = body.weightOz;
  if (weightOz !== null && !(typeof weightOz === "number" && Number.isFinite(weightOz) && weightOz >= 0 && weightOz < 1_000_000)) {
    return NextResponse.json({ error: "weightOz must be a number of ounces or null." }, { status: 400 });
  }
  if (typeof body.stable !== "boolean") {
    return NextResponse.json({ error: "stable must be true or false." }, { status: 400 });
  }

  const now = new Date();
  // updateMany so a deleted station is a count of 0, not a thrown error.
  const { count } = await prisma.station.updateMany({
    where: { id },
    data: {
      weightOz: weightOz === null ? null : Math.round(weightOz * 100) / 100,
      weightStable: weightOz !== null && body.stable,
      weightAt: weightOz === null ? null : now,
      lastSeenAt: now,
    },
  });
  if (count === 0) {
    return NextResponse.json({ error: "This station was deleted. Pick another one." }, { status: 404 });
  }
  return NextResponse.json({ ok: true });
}
