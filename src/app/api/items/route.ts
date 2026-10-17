import { getRequestUser } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { ItemStatus, type Item, type Prisma } from "@/generated/prisma/client";
import { NextRequest, NextResponse } from "next/server";
import { after } from "next/server";
import { randomUUID } from "node:crypto";
import { draftItem } from "@/lib/draftItem";
import { lookupCategoryForItem } from "@/lib/categoryLookup";
import { earliestBundleExpiration } from "@/lib/csv";
import { normalizeBreakdown } from "@/lib/expirationBreakdown";
import { inheritedFields, recordRelistPart, relistPlan, type RelistPart } from "@/lib/relist";
import { findBin, nextItemCode, placeInBin, WarehouseError } from "@/lib/warehouse/bins";
import { claimDudUnits, findDudBox, physicalUnits } from "@/lib/warehouse/dudBoxes";
import { settleDudBox } from "@/lib/warehouse/dudBoxReview";
import type { StoredReturnReport } from "@/lib/warehouse/returns";
import { classifyScan, normalizeCode } from "@/lib/warehouse/codes";
import { buildItemLabel, queueItemLabels } from "@/lib/warehouse/itemLabel";
import { isWarehouseMode } from "@/lib/warehouse/settings";
import { binProgress } from "@/lib/warehouse/binGate";

// Draft (up to 45s for a single item, or up to ~90s for a bundle — parallel
// per-component naming calls plus one final synthesis call) + category
// lookup (up to 100s worst case) can together take a while — give the
// function room to actually finish that work in after(), not just respond
// to the initial POST.
export const maxDuration = 190;

// List items for the review queue, optionally filtered by status.
export async function GET(request: NextRequest) {
  const status = request.nextUrl.searchParams.get("status");

  const items = await prisma.item.findMany({
    where: status ? { status: status as ItemStatus } : undefined,
    orderBy: { createdAt: "desc" },
  });

  // binProgress: warehouse items only ({inBins, needed}), so review can show
  // "No bin assigned yet" and hold Mark ready / Publish until it's binned.
  // Other items get no field, same response as before.
  const progress = await binProgress(items);
  return NextResponse.json(
    progress.size === 0 ? items : items.map((i) => (progress.has(i.id) ? { ...i, binProgress: progress.get(i.id) } : i))
  );
}

// Save one scanned item. Called from the mobile scan flow after photos have
// already been uploaded to Cloudinary, so this is just metadata + URLs.
type BundleComponentInput = {
  upc?: string;
  quantity?: number;
  photoUrls?: string[] | null;
  expirationDate?: string | null;
};

export async function POST(request: NextRequest) {
  const body = await request.json();
  const isBundle = Boolean(body.isBundle);
  // Warehouse mode (src/lib/warehouse): no typed shelf location, the sku is
  // a printed item code (ES000123), and the station PC prints a label per
  // sellable unit. The lister bags each unit with its label; the bags go
  // into bins later at the binning station, so normally no bin is sent.
  // Off = everything below works exactly as it always has.
  //
  // Which path is decided by what the page sent, not by the setting: the
  // page picks its flow when it loads, and Cristian can flip the switch
  // mid-shift. An item a handheld collected the warehouse way (stationId)
  // saves the warehouse way, one collected the old way (shelfLocation)
  // saves the old way, so nothing in progress gets rejected. Only a body
  // with neither falls back to the setting, to say which field is missing.
  const has = (v: unknown) => v !== undefined && v !== null && v !== "";
  const warehouse = has(body.stationId) ? true : has(body.shelfLocation) ? false : await isWarehouseMode();

  // UPC isn't required for single items either — custom/handmade products
  // (e.g. our own t-shirts) have no barcode, and export already falls back
  // to "Does Not Apply" for a missing UPC.
  const required = warehouse ? ["quantity", "stationId"] : ["quantity", "shelfLocation"];
  for (const field of required) {
    if (body[field] === undefined || body[field] === null || body[field] === "") {
      return NextResponse.json(
        { error: `Missing required field: ${field}` },
        { status: 400 }
      );
    }
  }

  if (isBundle) {
    const components: BundleComponentInput[] = Array.isArray(body.bundleComponents)
      ? body.bundleComponents
      : [];
    if (components.length === 0) {
      return NextResponse.json(
        { error: "A bundle needs at least one item added to it." },
        { status: 400 }
      );
    }
    const invalid = components.find((c) => !c.upc || !c.quantity || c.quantity < 1);
    if (invalid) {
      return NextResponse.json(
        { error: "Every item in the bundle needs a UPC and a quantity." },
        { status: 400 }
      );
    }
  }

  // Guided relist of a split multi-date listing (src/lib/relist.ts): the
  // UPC and manifest come from the original, never the phone, and the
  // past-date part is always Shopify & Whatnot only.
  const relistOf = typeof body.relistOf === "string" ? body.relistOf : null;
  const relistPart: RelistPart = body.relistPart === "past" ? "past" : "good";
  const original = relistOf ? await prisma.item.findUnique({ where: { id: relistOf } }) : null;
  if (relistOf) {
    const plan = original ? relistPlan(original) : null;
    if (!plan || isBundle) {
      return NextResponse.json({ error: "That listing isn't waiting to be relisted." }, { status: 400 });
    }
    if (plan[relistPart].done) {
      return NextResponse.json({ error: "Those units were already relisted." }, { status: 400 });
    }
  }

  // Returns mode (src/lib/warehouse/returns.ts): a return that wasn't in
  // the same condition, listed again in its real condition. Like a relist,
  // the UPC, manifest, category and specifics come from the original, and
  // the condition from the return; the new item is linked to the return in
  // the same transaction, so two saves can't both list it.
  const returnOf = typeof body.returnOf === "string" && body.returnOf ? body.returnOf : null;
  const returnRow = returnOf
    ? await prisma.itemReturn.findUnique({ where: { id: returnOf }, include: { item: true } })
    : null;
  if (returnOf) {
    if (!returnRow || (returnRow.decision !== "relist_new" && returnRow.decision !== "shopify_only") || isBundle || relistOf) {
      return NextResponse.json({ error: "That return isn't waiting to be listed." }, { status: 400 });
    }
    if (returnRow.newItemId) {
      return NextResponse.json({ error: "That return was already listed." }, { status: 400 });
    }
  }
  const returnOriginal = returnRow?.item ?? null;
  const returnReport = (returnRow?.report ?? null) as StoredReturnReport | null;

  // Listing from a dud box (src/lib/warehouse/dudBoxes.ts): units the dud
  // processor marked "shopify". The manifest is the box's and the item is
  // Shopify & Whatnot only whatever the page sent; the units come off the
  // box's entries in the same transaction as the item.
  const dudBoxCode = has(body.dudBoxCode) ? normalizeCode(String(body.dudBoxCode)) : "";
  let dudBox: Awaited<ReturnType<typeof findDudBox>> | null = null;
  if (dudBoxCode) {
    if (isBundle || relistOf || returnOf) {
      return NextResponse.json({ error: "Bundles, relists and returns can't be listed from a dud box." }, { status: 400 });
    }
    if (!has(body.upc)) {
      return NextResponse.json({ error: "Scan the product's UPC to list it from the dud box." }, { status: 400 });
    }
    const q = Number(body.quantity);
    if (!Number.isInteger(q) || q < 1) {
      return NextResponse.json({ error: "Quantity has to be a whole number, at least 1." }, { status: 400 });
    }
    try {
      dudBox = await findDudBox(prisma, dudBoxCode);
    } catch (e) {
      if (e instanceof WarehouseError) return NextResponse.json({ error: e.message }, { status: e.status });
      throw e;
    }
  }

  // Warehouse mode checks, all before anything is written: a wrong bin or a
  // deleted station should leave nothing behind (not even a used-up item
  // code), so the lister can just fix it and save again. binCode is
  // optional: sent, the units go straight into that bin; not sent (the
  // normal case), they're in no bin until the binning station scans them.
  const username = getRequestUser(request)?.username ?? null;
  const units = Number(body.quantity);
  const binCode =
    warehouse && body.binCode != null && String(body.binCode).trim() !== "" ? normalizeCode(String(body.binCode)) : "";
  const stationId = warehouse ? String(body.stationId) : "";
  if (warehouse) {
    // One unit = one label = one bag, so it has to be whole.
    if (!Number.isInteger(units) || units < 1) {
      return NextResponse.json({ error: "Quantity has to be a whole number, at least 1." }, { status: 400 });
    }
    if (binCode) {
      if (classifyScan(binCode) !== "bin") {
        return NextResponse.json({ error: `${binCode} isn't a bin label. Bin labels start with BN.` }, { status: 400 });
      }
      try {
        await findBin(prisma, binCode);
      } catch (e) {
        if (e instanceof WarehouseError) return NextResponse.json({ error: e.message }, { status: e.status });
        throw e;
      }
    }
    const station = await prisma.station.findUnique({ where: { id: stationId }, select: { id: true } });
    if (!station) {
      return NextResponse.json({ error: "That station doesn't exist anymore. Pick a station again." }, { status: 404 });
    }
  }

  // Prefix the SKU with the shelf location (e.g. "(Location - A6)-<uuid>")
  // so it's recognizable at a glance on eBay's side, not just a bare UUID.
  // Warehouse mode: the printed item code instead, which is also what
  // staff scan to pick it (the location lives in the bin now). That one is
  // taken inside the transaction below, so a save that fails there (a dud
  // box with nothing left, a return listed twice) doesn't use one up.
  const sku = warehouse ? "" : `(Location - ${String(body.shelfLocation).trim()})-${randomUUID()}`;

  // A bundle's dates are scanned per piece; the bundle itself takes the
  // earliest. The dashboard's expiring list and the hourly auto-end only
  // read the item's own date, so without this a bundle never expired: a
  // Mucinex lot with two bottles dated 9/30/2026 stayed live (2026-10-05).
  const bundleExpiration = isBundle ? earliestBundleExpiration(body.bundleComponents) : null;
  // Units with different dates in one listing: the listing goes by the
  // oldest, whatever single date the client sent.
  let expirationBreakdown: ReturnType<typeof normalizeBreakdown> = null;
  try {
    expirationBreakdown = isBundle ? null : normalizeBreakdown(body.expirationBreakdown);
  } catch (e) {
    return NextResponse.json({ error: (e as Error).message }, { status: 400 });
  }
  const expirationDate = expirationBreakdown?.[0].date ?? body.expirationDate ?? bundleExpiration;

  const data: Prisma.ItemUncheckedCreateInput = {
    sku,
    upc: original ? original.upc : returnOriginal ? returnOriginal.upc : isBundle ? null : body.upc || null,
    quantity: Number(body.quantity),
    isMultipack: Boolean(body.isMultipack),
    packSize: body.isMultipack ? Number(body.packSize) : null,
    expirationDate: expirationDate ? new Date(expirationDate) : null,
    expirationBreakdown: expirationBreakdown ?? undefined,
    // Required column; in warehouse mode where things are comes from the
    // bins (BinContent), so it's left blank.
    shelfLocation: warehouse ? "" : body.shelfLocation,
    boxSize: body.boxSize ?? null,
    weightLbs: body.weightLbs != null ? Number(body.weightLbs) : null,
    weightOz: body.weightOz != null ? Number(body.weightOz) : null,
    photoUrls: Array.isArray(body.photoUrls) ? body.photoUrls : [],
    // Who's signed in, not anything the client sends — this is what the
    // scan-speed report (/reports/scan-speed) attributes the scan to.
    scannedBy: username,
    manifestId: original
      ? original.manifestId
      : returnOriginal
        ? returnOriginal.manifestId
        : dudBox
          ? dudBox.manifestId
          : body.manifestId ?? null,
    isBundle,
    bundleComponents: isBundle ? body.bundleComponents : undefined,
    shopifyOnly:
      !isBundle &&
      (body.shopifyOnly === true ||
        (original != null && relistPart === "past") ||
        returnRow?.decision === "shopify_only" ||
        dudBox != null),
    ...(original ? inheritedFields(original) : {}),
    ...(returnOriginal
      ? {
          ...inheritedFields(returnOriginal),
          // Its real condition now, not the original's.
          condition: (returnReport?.listCondition ?? "used") as Item["condition"],
          // Same product: skips a UPC lookup, and the draft starts from it.
          upcLookupData: (returnOriginal.upcLookupData ?? undefined) as Prisma.InputJsonValue | undefined,
        }
      : {}),
  };

  let item: Item;
  let labelsQueued = 0;
  if (warehouse || returnRow || dudBox) {
    // The label's name and date are looked up before the transaction so it
    // only holds a connection for the writes themselves.
    const payload = !warehouse
      ? null
      : await buildItemLabel(
      prisma,
      {
        sku,
        upc: (data.upc as string | null) ?? null,
        manifestId: (data.manifestId as string | null) ?? null,
        isBundle,
        isMultipack: Boolean(data.isMultipack),
        packSize: (data.packSize as number | null) ?? null,
        expirationDate: data.expirationDate instanceof Date ? data.expirationDate : null,
        condition: (data.condition as string | null | undefined) ?? null,
      },
      typeof body.productName === "string" ? body.productName : null
    );
    // Item, labels, bin contents (when a bin was sent), dud box units and
    // the return link land together or not at all: no labels for an item
    // that didn't save, no dud units claimed for nothing.
    try {
      ({ item, labelsQueued } = await prisma.$transaction(
        async (tx) => {
          // Dud units first: a box with too few left fails before an item
          // code is even taken.
          if (dudBox) {
            await claimDudUnits(tx, {
              dudBoxCode: dudBox.code,
              upc: String(data.upc),
              units: physicalUnits({
                quantity: units,
                isMultipack: Boolean(data.isMultipack),
                packSize: (data.packSize as number | null) ?? null,
              }),
            });
            // The last Shopify unit listed out of a fully decided box
            // finishes it right away, instead of on the next box view.
            await settleDudBox(tx, dudBox.id);
          }
          const code = warehouse ? await nextItemCode(tx) : sku;
          const created = await tx.item.create({ data: { ...data, sku: code } });
          if (returnRow) {
            const linked = await tx.itemReturn.updateMany({
              where: { id: returnRow.id, newItemId: null },
              data: { newItemId: created.id },
            });
            if (linked.count === 0) throw new WarehouseError("That return was already listed.");
          }
          // A bundle's units are whole bundles (its quantity), same as a
          // multi-pack's are whole packs: one bag, one label each.
          if (warehouse && binCode) await placeInBin(tx, { itemId: created.id, binCode, units, by: username });
          const queued =
            warehouse && payload
              ? await queueItemLabels(tx, { stationId, payload: { ...payload, code }, copies: units, by: username })
              : 0;
          return { item: created, labelsQueued: queued };
        },
        { maxWait: 10_000, timeout: 20_000 }
      ));
    } catch (e) {
      if (e instanceof WarehouseError) return NextResponse.json({ error: e.message }, { status: e.status });
      throw e;
    }
  } else {
    item = await prisma.item.create({ data });
  }

  const relistNext = original ? await recordRelistPart(original.id, relistPart, item.id) : undefined;
  // A return keeps its original's category too.
  const keepCategory = Boolean(original?.categoryId ?? returnOriginal?.categoryId);

  // Run drafting + category lookup here, after responding, so it's fully
  // server-side and doesn't depend on the phone's browser tab staying in the
  // foreground. (An earlier version had the client fire these as separate
  // fetches instead — but the "+ Photo" button launches the native camera
  // app via capture="environment", which backgrounds the tab almost
  // immediately during real scanning, and mobile browsers suspend
  // backgrounded network activity — very likely killing those requests
  // mid-flight before the ~45-100s of work finished.) Category lookup runs
  // after drafting so it has a real title to search from, not just the UPC.
  after(async () => {
    try {
      await draftItem(item.id);
    } catch (e) {
      console.error(`[items after()] ${item.id}: draft failed`, e);
      return;
    }
    // A relist already has the original's category.
    if (keepCategory) return;
    try {
      await lookupCategoryForItem(item.id);
    } catch (e) {
      console.error(`[items after()] ${item.id}: category lookup failed`, e);
    }
  });

  // relistNext: the relist part still to do (null = finished), only on a relist.
  // labelsQueued: warehouse mode only, labels sent to the station's printer.
  return NextResponse.json({ ...item, relistNext, ...(warehouse ? { labelsQueued } : {}) }, { status: 201 });
}
