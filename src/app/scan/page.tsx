"use client";

import BarcodeScanner from "@/components/BarcodeScanner";
import { formatLbOz, formatOz, LiveWeightReadout, packageWeight, useStationWeight } from "@/components/LiveWeight";
import { PackSuggestionCard } from "@/components/PackSuggestionCard";
import { ScanField } from "@/components/ScanField";
import { StationOnline, StationPicker, useChosenStation } from "@/components/StationPicker";
import { Alert } from "@/components/ui/Alert";
import { AppShell } from "@/components/ui/AppShell";
import { Badge } from "@/components/ui/Badge";
import { Button, buttonClasses } from "@/components/ui/Button";
import { Card, SectionHeader } from "@/components/ui/Card";
import { cn } from "@/components/ui/cn";
import { CheckboxRow, Field, Input, Select } from "@/components/ui/Input";
import { uploadPhoto } from "@/lib/uploadPhoto";
import { CounterSaleCheckout } from "@/components/CounterSaleCheckout";
import { useCurrentUser } from "@/components/UserNav";
import {
  ArrowLeft,
  ArrowRight,
  Ban,
  Boxes,
  Camera,
  Check,
  ChevronRight,
  CircleCheck,
  FileSpreadsheet,
  LoaderCircle,
  Package,
  PackageX,
  Plus,
  Printer,
  RotateCcw,
  ScanBarcode,
  Search,
  SearchX,
  ShoppingBag,
  Trash2,
  TriangleAlert,
  X,
  type LucideIcon,
} from "lucide-react";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { describeBreakdown } from "@/lib/expirationBreakdown";
import type { RelistPart, RelistPlan } from "@/lib/relist";
import { upcMatchKeys } from "@/lib/upcMatch";
import { classifyScan, normalizeCode } from "@/lib/warehouse/codes";
import type { ReturnListingPlan } from "@/lib/warehouse/returns";
import type { SortLocation } from "@/lib/warehouse/sortBoxes";
import { Suspense, useEffect, useRef, useState, type ComponentProps, type ReactNode } from "react";

type Photo = {
  id: string;
  previewUrl: string;
  status: "uploading" | "done" | "error";
  cloudinaryUrl?: string;
};

type LabeledEntry = {
  id: string;
  label: string;
};

// Warehouse mode: a box's barcode (BX001) and empty weight. tareOz can
// arrive as a Decimal string, hence Number() wherever it's used.
type BoxSizeEntry = LabeledEntry & {
  code?: string | null;
  tareOz?: number | string | null;
};

// GET /api/dud-boxes/{code}: a dud box and what's in it. decision
// "shopify" entries are the ones listed from here.
type DudBoxInfo = {
  code: string;
  manifestId: string;
  manifestTitle: string | null;
  entries: { id: string; upc: string; description: string; quantity: number; listedUnits: number; decision: string | null }[];
};

// Why a UPC can't be listed from this dud box, or null when it can.
function dudBoxRefusal(box: DudBoxInfo, upc: string): string | null {
  const keys = new Set(upcMatchKeys(upc));
  const shopify = box.entries.filter((e) => e.decision === "shopify" && upcMatchKeys(e.upc).some((k) => keys.has(k)));
  if (shopify.length === 0) return `Not marked for Shopify in dud box ${box.code} yet.`;
  if (shopify.every((e) => e.quantity - e.listedUnits <= 0)) return `All of this product in dud box ${box.code} is already listed.`;
  return null;
}

function boxTareOz(box: BoxSizeEntry | undefined): number | null {
  if (box?.tareOz == null || box.tareOz === "") return null;
  const n = Number(box.tareOz);
  return Number.isFinite(n) ? n : null;
}

type BundleComponentDraft = {
  id: string;
  upc: string;
  quantity: string;
  photos: Photo[];
  expirationDate: string;
};

// A guided step-by-step flow instead of one long form — built for scanning
// with a handheld barcode scanner (e.g. a Wasp/Unitech device in keyboard-
// wedge mode): it "types" a scan into whatever text input is focused,
// usually followed by an Enter keystroke. Enter on the UPC/shelf-location
// steps advances to the next step, so a physical trigger-pull moves the
// flow forward without touching the screen.
type Step =
  | "mode"
  | "photos"
  | "upc"
  | "quantity"
  | "expiration"
  | "bundleHeroPhoto"
  | "bundleComponents"
  | "bundleQuantity"
  | "shelfLocation"
  | "boxWeight";

// UPC and pack/quantity come before photos on purpose (Cristian): the
// quantity step suggests a pack size, and if it says "sell as 4-packs"
// when only 3 are in hand, the item can be set aside until the rest turn
// up — before any photos have been taken of it.
const SINGLE_STEPS: Step[] = ["mode", "upc", "quantity", "expiration", "photos", "shelfLocation", "boxWeight"];
const BUNDLE_STEPS: Step[] = ["mode", "bundleHeroPhoto", "bundleComponents", "bundleQuantity", "shelfLocation", "boxWeight"];
// Warehouse mode (src/lib/warehouse): no shelf step. The lister weighs it
// on the station's scale, scans the box, saves, and bags each unit with
// the labels that print. Bins are filled later at a separate binning
// station by scanning those labels, so there's no bin step here.
const WAREHOUSE_SINGLE_STEPS: Step[] = ["mode", "upc", "quantity", "expiration", "photos", "boxWeight"];
const WAREHOUSE_BUNDLE_STEPS: Step[] = ["mode", "bundleHeroPhoto", "bundleComponents", "bundleQuantity", "boxWeight"];

// Whether this device is mid-scanning, so a reload (the camera app
// backgrounding the tab can do that) lands back in the scan flow instead of
// the start screen. Replaced server-side scan sessions on 2026-09-27: with
// manifests and every item saved as it's scanned, there was nothing left
// for a session to hold on to.
const SCANNING_KEY = "ebay-tool.scanning";
const OLD_SESSION_KEY = "ebay-tool.activeScanSessionId";
const ACTIVE_MANIFEST_KEY = "ebay-tool.activeManifestId";

function startSinglePhotoUpload(file: File, setPhoto: (p: Photo | null) => void) {
  const id = `${Date.now()}-${Math.random()}`;
  const previewUrl = URL.createObjectURL(file);
  setPhoto({ id, previewUrl, status: "uploading" });
  uploadPhoto(file)
    .then((url) => setPhoto({ id, previewUrl, status: "done", cloudinaryUrl: url }))
    .catch(() => setPhoto({ id, previewUrl, status: "error" }));
}

// The walk-up sale's floor/ideal/near-expiry prices come from the manifest
// LINE (per single physical unit — ManifestLine has no pack concept at
// all), but "already inventoried" quantity is in eBay LISTING units, which
// for a multipack Item means packs, not loose singles. Selling "1" of an
// already-listed 2-pack means 1 pack = 2 physical units for a price that
// should be ~2x the manifest line's single-unit price, not the same number.
// Only applies when actually selling against the already-listed Item — a
// fresh-off-the-manifest sale is always single physical units regardless
// of how some OTHER already-listed Item for the same UPC happens to be
// packed.
function walkupPackMultiplier(
  alreadyListed: { isMultipack: boolean; packSize: number | null } | null,
  alreadyInventoried: boolean
): number {
  return alreadyInventoried && alreadyListed?.isMultipack && alreadyListed.packSize ? alreadyListed.packSize : 1;
}

export default function ScanPage() {
  return (
    <Suspense>
      <ScanPageInner />
    </Suspense>
  );
}

function ScanPageInner() {
  const searchParams = useSearchParams();
  // Cost and the floor price are the owner's; the lookups leave them out
  // for everyone else.
  const isOwner = useCurrentUser()?.role === "owner";
  const router = useRouter();
  const [scanning, setScanning] = useState(false);
  const [savedThisSession, setSavedThisSession] = useState(0);

  // Manifest mode is an addition on top of the normal flow, not a
  // replacement — items scanned with no manifest attached behave exactly as
  // before. Reached via the "Scan with Manifest" link, which lands here
  // with ?manifestId=... after picking/uploading one on /manifests.
  const [activeManifestId, setActiveManifestId] = useState<string | null>(() => {
    if (typeof window === "undefined") return null;
    return searchParams.get("manifestId") ?? localStorage.getItem(ACTIVE_MANIFEST_KEY);
  });
  const [manifestTitle, setManifestTitle] = useState<string | null>(null);
  const [damagedMode, setDamagedMode] = useState(false);
  const [damagedUpc, setDamagedUpc] = useState("");
  const [damagedQuantity, setDamagedQuantity] = useState("1");
  const [damagedSaving, setDamagedSaving] = useState(false);
  const [damagedMessage, setDamagedMessage] = useState<string | null>(null);

  // Physically arrived in good condition, just never going to be listed
  // (dead event merch, no resale value, etc.) — same sorting-only tally
  // pattern as damagedMode above, just a different reason/bucket so it
  // still counts as accounted-for instead of showing up as "missing."
  const [dudMode, setDudMode] = useState(false);
  const [dudUpc, setDudUpc] = useState("");
  const [dudQuantity, setDudQuantity] = useState("1");
  const [dudSaving, setDudSaving] = useState(false);
  const [dudMessage, setDudMessage] = useState<string | null>(null);

  // In-person, cash, no-fee/no-shipping sale straight out of the manifest —
  // scan the UPC, get instant pricing (no math at the table), mark it sold,
  // loop back for the next one. See /api/manifests/[id]/walkup-sale/lookup.
  const [walkupMode, setWalkupMode] = useState(false);
  const [walkupUpc, setWalkupUpc] = useState("");
  const [walkupLooking, setWalkupLooking] = useState(false);
  const [walkupMessage, setWalkupMessage] = useState<string | null>(null);
  const [walkupLookup, setWalkupLookup] = useState<{
    description: string;
    retailPrice: number;
    landedCostPerUnit: number | null;
    floorPrice: number | null;
    idealPrice: number;
    nearExpiryPrice: number;
    alreadyListed: {
      itemId: string;
      availableQuantity: number;
      isMultipack: boolean;
      packSize: number | null;
    } | null;
  } | null>(null);
  // Defaults to whatever the lookup found (checked when the UPC matches an
  // already-listed Item) — see lookupWalkupUpc. Checked = reduce the live
  // eBay listing and record the sale on that Item directly; unchecked =
  // today's "fresh off the manifest" tally.
  const [walkupAlreadyInventoried, setWalkupAlreadyInventoried] = useState(false);
  // The UPC a lookup just came back empty for — kept for display after the
  // field itself is cleared for the next scan (see lookupWalkupUpc).
  const [walkupMissedUpc, setWalkupMissedUpc] = useState<string | null>(null);

  // "Sell Shelf Item" — same in-person/cash sale as Walk-up Sale above, but
  // for something that's already on the shelf (already scanned in and
  // listed) rather than mid-sort on a manifest. Found by shelf location +
  // UPC instead of requiring an active manifest session, since there's no
  // way to know which manifest a shelf item came from just by looking at
  // it — see GET /api/items/shelf-lookup. Reachable without starting
  // scanning or picking a manifest first (rendered before the start screen
  // below), unlike Walk-up Sale.
  const [shelfSaleMode, setShelfSaleMode] = useState(false);
  const [shelfSaleLocation, setShelfSaleLocation] = useState("");
  const [shelfSaleUpc, setShelfSaleUpc] = useState("");
  const [shelfSaleLooking, setShelfSaleLooking] = useState(false);
  const [shelfSaleMessage, setShelfSaleMessage] = useState<string | null>(null);
  const [shelfSaleLookup, setShelfSaleLookup] = useState<{
    itemId: string;
    manifestId: string | null;
    // Warehouse mode: the bin on the scanned shelf that holds it.
    binCode?: string | null;
    description: string;
    retailPrice?: number;
    landedCostPerUnit?: number | null;
    floorPrice?: number | null;
    idealPrice?: number;
    nearExpiryPrice?: number;
    currentListedPrice?: number | null;
    isBundle?: boolean;
    note?: string;
    alreadyListed: {
      itemId: string;
      availableQuantity: number;
      isMultipack: boolean;
      packSize: number | null;
    };
  } | null>(null);
  // Same as walkupMissedUpc: what the last empty-handed lookup tried.
  const [shelfSaleMissed, setShelfSaleMissed] = useState<{ location: string; upc: string } | null>(null);

  const [step, setStep] = useState<Step>("mode");
  const [isBundle, setIsBundle] = useState(false);

  // Single-item mode
  const [photos, setPhotos] = useState<Photo[]>([]);
  const [upc, setUpc] = useState("");
  const [isMultipack, setIsMultipack] = useState(false);
  // Set from the pack suggestion's "Sell on Shopify & Whatnot instead": this
  // item skips eBay entirely. Cleared for every new item.
  const [shopifyOnly, setShopifyOnly] = useState(false);
  const [packSize, setPackSize] = useState("");
  const [expirationDate, setExpirationDate] = useState("");
  // Units that came in with a different date than the first one (a 3-pack
  // with 2 tubes dated one month and 1 another). Empty = one date for all.
  // Lizvet used to make these bundles; now it's one listing whose
  // description lists each date.
  const [extraDates, setExtraDates] = useState<{ date: string; units: string }[]>([]);
  const [firstDateUnits, setFirstDateUnits] = useState("");
  // Guided relist from the dashboard (/scan?relist={id}): a multi-date
  // listing the sweep pulled, redone as the still-good units (eBay) and
  // then the past-date ones (Shopify & Whatnot only), on its own manifest.
  const [relist, setRelist] = useState<{ plan: RelistPlan; part: RelistPart } | null>(null);
  // The manifest being scanned before the relist switched to the
  // original's, put back when it's over so the next scans land right.
  const preRelistManifest = useRef<string | null | undefined>(undefined);
  // Listing a customer return in its real condition (/scan?return={id},
  // sent from the Returns page): prefilled like a relist, straight to
  // photos. Uses the same manifest put-back as the relist when it's over.
  const [returnPlan, setReturnPlan] = useState<ReturnListingPlan | null>(null);
  // Warehouse mode: listing the Shopify-marked units of a dud box (scan its
  // DB label). Every item saved this way is Shopify & Whatnot only and on
  // the box's manifest; the lister isn't asked about channels.
  const [dudBox, setDudBox] = useState<DudBoxInfo | null>(null);
  // Warehouse mode, listing into a manifest: the load was sorted into sort
  // boxes first. Scanning a product pulls every unit of it out of its boxes
  // to the table (POST /api/sort-boxes/pull); this is what to go grab, for
  // the UPC it was pulled for.
  const [sortPull, setSortPull] = useState<{
    upc: string;
    pulled: { boxCode: string; units: number }[];
    locations: SortLocation[];
  } | null>(null);
  const [dudBoxScan, setDudBoxScan] = useState("");
  const preDudManifest = useRef<string | null | undefined>(undefined);

  // Bundle mode — expiration is asked per item added to the bundle, not
  // once for the whole listing, since different items in the same bundle
  // can have different (or no) expiration dates.
  const [heroPhoto, setHeroPhoto] = useState<Photo | null>(null);
  const [bundleComponents, setBundleComponents] = useState<BundleComponentDraft[]>([]);
  const [componentUpc, setComponentUpc] = useState("");
  const [componentQuantity, setComponentQuantity] = useState("1");
  const [componentPhotos, setComponentPhotos] = useState<Photo[]>([]);
  const [componentExpirationDate, setComponentExpirationDate] = useState("");

  // Shared
  const [quantity, setQuantity] = useState("1"); // bundle mode: "how many bundles"
  const [shelfLocation, setShelfLocation] = useState("");
  const [boxSize, setBoxSize] = useState("");
  const [weightLbs, setWeightLbs] = useState("");
  const [weightOz, setWeightOz] = useState("");

  const [shelfLocations, setShelfLocations] = useState<LabeledEntry[]>([]);
  const [boxSizes, setBoxSizes] = useState<BoxSizeEntry[]>([]);

  // Warehouse mode (Settings). Off until the check comes back, and off =
  // this page works exactly as it always has. On = the station, scale, box
  // barcode steps below, and labels print at the station on save.
  const [warehouseMode, setWarehouseMode] = useState(false);
  // The mode check failed twice: showing the normal flow, with a warning.
  const [modeUnknown, setModeUnknown] = useState(false);
  const stationChoice = useChosenStation(warehouseMode);
  const station = stationChoice.station;
  const [pickingStation, setPickingStation] = useState(false);
  const [boxScan, setBoxScan] = useState("");
  // The item's own weight off the scale, before the box is added. null =
  // the weight wasn't taken from the scale (typed in, or not yet).
  const [scaleOz, setScaleOz] = useState<number | null>(null);
  // Typing in the lb/oz boxes switches the auto-fill off for this item, so
  // a jiggle on the scale can't overwrite what someone typed on purpose.
  const [typedWeight, setTypedWeight] = useState(false);
  // Whether the weight was taken (or typed) for THIS item. The weight is
  // kept from the item before, same as it always was, but this says so if
  // nobody's put the new one on the scale yet.
  const [weightIsFresh, setWeightIsFresh] = useState(false);
  // The last save's labels, for the "Printing N labels" card and Reprint.
  const [lastSaved, setLastSaved] = useState<{
    itemId: string;
    code: string;
    labels: number;
    stationName: string;
  } | null>(null);
  const [reprinting, setReprinting] = useState(false);
  const [reprintMessage, setReprintMessage] = useState<string | null>(null);

  const [showScanner, setShowScanner] = useState(false);
  const [scanTarget, setScanTarget] = useState<"item" | "component" | "location">("item");
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const heroFileInputRef = useRef<HTMLInputElement>(null);
  const componentFileInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    // Initial hydration from localStorage/API on mount, not a reaction to
    // state we own.
    // A device still carrying an old scan-session id was mid-scan too.
    const wasScanning = localStorage.getItem(SCANNING_KEY) === "1" || localStorage.getItem(OLD_SESSION_KEY) !== null;
    localStorage.removeItem(OLD_SESSION_KEY);
    // Arrived via "Scan into this manifest": straight into scanning.
    if (wasScanning || searchParams.get("manifestId")) startScanning();
    const relistId = searchParams.get("relist");
    if (relistId) {
      fetch(`/api/items/${relistId}/relist`)
        .then(async (r) => {
          const data = await r.json();
          if (!r.ok) throw new Error(data.error ?? "Couldn't load that relist.");
          return data as RelistPlan;
        })
        .then((plan) => {
          if (!plan.next) throw new Error("That one's already relisted.");
          startScanning();
          applyRelistPart(plan, plan.next);
        })
        .catch((e) => setMessage(e instanceof Error ? e.message : "Couldn't load that relist."));
    }
    const returnId = searchParams.get("return");
    if (returnId) {
      fetch(`/api/returns/${returnId}`)
        .then(async (r) => {
          const data = await r.json().catch(() => ({}));
          if (!r.ok) throw new Error(data.error ?? "Couldn't load that return.");
          return data as ReturnListingPlan;
        })
        .then((plan) => {
          startScanning();
          applyReturnPlan(plan);
        })
        .catch((e) => setMessage(e instanceof Error ? e.message : "Couldn't load that return."));
    }
    fetch("/api/shelf-locations")
      .then((r) => r.json())
      .then(setShelfLocations);
    fetch("/api/box-sizes")
      .then((r) => r.json())
      .then(setBoxSizes);
    // Tried twice. If it still can't tell, the normal flow shows (the
    // server saves whichever way the page collected the item) with a
    // warning, since the labels won't print that way.
    const checkMode = async (): Promise<boolean> => {
      const r = await fetch("/api/warehouse/mode", { cache: "no-store" });
      if (!r.ok) throw new Error(`mode check ${r.status}`);
      const d: { on?: boolean } = await r.json();
      return d.on === true;
    };
    checkMode()
      .catch(() => new Promise((wait) => setTimeout(wait, 1500)).then(checkMode))
      .then((on) => {
        setModeUnknown(false);
        if (!on) return;
        setWarehouseMode(true);
        // Already past the photos (a reload mid-item): the shelf step
        // doesn't exist in warehouse mode, the scale step takes its place.
        setStep((s) => (s === "shelfLocation" ? "boxWeight" : s));
      })
      .catch(() => setModeUnknown(true));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    // Sync whichever manifest is active to localStorage and fetch its
    // title for the banner — activeManifestId itself is set from the URL
    // or localStorage at initial state, or by picking one mid-session.
    if (!activeManifestId) return;
    localStorage.setItem(ACTIVE_MANIFEST_KEY, activeManifestId);
    fetch(`/api/manifests/${activeManifestId}`)
      .then((r) => r.json())
      .then((data: { title?: string }) => setManifestTitle(data.title ?? null))
      .catch(() => setManifestTitle(null));
  }, [activeManifestId]);

  function startScanning() {
    setScanning(true);
    localStorage.setItem(SCANNING_KEY, "1");
  }

  function finishScanning() {
    localStorage.removeItem(SCANNING_KEY);
    localStorage.removeItem(ACTIVE_MANIFEST_KEY);
    setScanning(false);
    setActiveManifestId(null);
    setManifestTitle(null);
    setDamagedMode(false);
    setDudMode(false);
    setWalkupMode(false);
    resetWalkupSale();
    setShelfSaleMode(false);
    resetShelfSale();
    setSavedThisSession(0);
    setLastSaved(null);
    setReprintMessage(null);
    setDudBox(null);
    preDudManifest.current = undefined;
  }

  async function saveDamagedEntry() {
    if (!activeManifestId) return;
    setDamagedMessage(null);
    if (!damagedUpc.trim()) return setDamagedMessage("Scan or enter a UPC first.");
    const qty = Number(damagedQuantity);
    if (!qty || qty < 1) return setDamagedMessage("Enter a quantity of at least 1.");

    setDamagedSaving(true);
    try {
      const res = await fetch(`/api/manifests/${activeManifestId}/damaged`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ upc: damagedUpc.trim(), quantity: qty }),
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        throw new Error(err.error ?? "Save failed.");
      }
      setDamagedUpc("");
      setDamagedQuantity("1");
      setDamagedMessage("Logged. Ready for the next one.");
    } catch (e) {
      setDamagedMessage(e instanceof Error ? e.message : "Something went wrong.");
    } finally {
      setDamagedSaving(false);
    }
  }

  async function saveDudEntry() {
    if (!activeManifestId) return;
    setDudMessage(null);
    if (!dudUpc.trim()) return setDudMessage("Scan or enter a UPC first.");
    const qty = Number(dudQuantity);
    if (!qty || qty < 1) return setDudMessage("Enter a quantity of at least 1.");

    setDudSaving(true);
    try {
      const res = await fetch(`/api/manifests/${activeManifestId}/duds`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ upc: dudUpc.trim(), quantity: qty }),
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        throw new Error(err.error ?? "Save failed.");
      }
      setDudUpc("");
      setDudQuantity("1");
      setDudMessage("Logged. Ready for the next one.");
    } catch (e) {
      setDudMessage(e instanceof Error ? e.message : "Something went wrong.");
    } finally {
      setDudSaving(false);
    }
  }

  function resetWalkupSale() {
    setWalkupUpc("");
    setWalkupLookup(null);
    setWalkupAlreadyInventoried(false);
    setWalkupMessage(null);
    setWalkupMissedUpc(null);
  }

  async function lookupWalkupUpc() {
    if (!activeManifestId) return;
    setWalkupMessage(null);
    if (!walkupUpc.trim()) return setWalkupMessage("Scan or enter a UPC first.");

    setWalkupLooking(true);
    setWalkupMissedUpc(null);
    try {
      const res = await fetch(
        `/api/manifests/${activeManifestId}/walkup-sale/lookup?upc=${encodeURIComponent(walkupUpc.trim())}`
      );
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? "Lookup failed.");
      setWalkupLookup(data);
      // Finding a matching active listing strongly implies this IS that
      // case — default checked, but let it be unchecked manually.
      setWalkupAlreadyInventoried(Boolean(data.alreadyListed));
    } catch (e) {
      setWalkupLookup(null);
      setWalkupMessage(e instanceof Error ? e.message : "Something went wrong.");
      // Nothing came up — clear the field and put the cursor back in it, so
      // the very next trigger pull is a fresh scan with nothing to tap.
      setWalkupMissedUpc(walkupUpc.trim());
      setWalkupUpc("");
      focusScanField("walkup-upc");
    } finally {
      setWalkupLooking(false);
    }
  }

  function resetShelfSale() {
    setShelfSaleLocation("");
    setShelfSaleUpc("");
    setShelfSaleLookup(null);
    setShelfSaleMessage(null);
    setShelfSaleMissed(null);
  }

  // Start over from the shelf location after a lookup came back empty — in
  // case it was the shelf scan that was wrong, not the UPC.
  function restartShelfSaleScan() {
    resetShelfSale();
    focusScanField("shelf-sale-location");
  }

  async function lookupShelfSaleItem() {
    setShelfSaleMessage(null);
    if (!shelfSaleLocation.trim()) return setShelfSaleMessage("Scan or enter a shelf location first.");
    if (!shelfSaleUpc.trim()) return setShelfSaleMessage("Scan or enter a UPC first.");

    setShelfSaleLooking(true);
    setShelfSaleMissed(null);
    try {
      const res = await fetch(
        `/api/items/shelf-lookup?shelfLocation=${encodeURIComponent(shelfSaleLocation.trim())}&upc=${encodeURIComponent(shelfSaleUpc.trim())}`
      );
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? "Lookup failed.");
      setShelfSaleLookup(data);
    } catch (e) {
      setShelfSaleLookup(null);
      setShelfSaleMessage(e instanceof Error ? e.message : "Something went wrong.");
      // Nothing came up — ready the UPC field for another scan right away
      // (the shelf location is usually right; "Start over" covers when not).
      setShelfSaleMissed({ location: shelfSaleLocation.trim(), upc: shelfSaleUpc.trim() });
      setShelfSaleUpc("");
      focusScanField("shelf-sale-upc");
    } finally {
      setShelfSaleLooking(false);
    }
  }

  function addPhotosTo(files: FileList | null, setPhotos: React.Dispatch<React.SetStateAction<Photo[]>>) {
    if (!files) return;
    Array.from(files).forEach((file) => {
      const id = `${Date.now()}-${Math.random()}`;
      const previewUrl = URL.createObjectURL(file);
      setPhotos((prev) => [...prev, { id, previewUrl, status: "uploading" }]);

      uploadPhoto(file)
        .then((url) => {
          setPhotos((prev) =>
            prev.map((p) =>
              p.id === id ? { ...p, status: "done", cloudinaryUrl: url } : p
            )
          );
        })
        .catch(() => {
          setPhotos((prev) =>
            prev.map((p) => (p.id === id ? { ...p, status: "error" } : p))
          );
        });
    });
  }

  function handleFiles(files: FileList | null) {
    addPhotosTo(files, setPhotos);
  }

  function handleComponentFiles(files: FileList | null) {
    addPhotosTo(files, setComponentPhotos);
  }

  function removePhoto(id: string) {
    setPhotos((prev) => prev.filter((p) => p.id !== id));
  }

  function removeComponentPhoto(id: string) {
    setComponentPhotos((prev) => prev.filter((p) => p.id !== id));
  }

  function addBundleComponent() {
    if (!componentUpc.trim() || !componentQuantity || Number(componentQuantity) < 1) return;
    if (componentPhotos.some((p) => p.status === "uploading")) return;
    setBundleComponents((prev) => [
      ...prev,
      {
        id: `${Date.now()}-${Math.random()}`,
        upc: componentUpc.trim(),
        quantity: componentQuantity,
        photos: componentPhotos,
        expirationDate: componentExpirationDate,
      },
    ]);
    setComponentUpc("");
    setComponentQuantity("1");
    setComponentPhotos([]);
    setComponentExpirationDate("");
    if (componentFileInputRef.current) componentFileInputRef.current.value = "";
  }

  function removeBundleComponent(id: string) {
    setBundleComponents((prev) => prev.filter((c) => c.id !== id));
  }

  function resetForm() {
    setShopifyOnly(false);
    setPhotos([]);
    setUpc("");
    setIsMultipack(false);
    setPackSize("");
    setHeroPhoto(null);
    setBundleComponents([]);
    setComponentUpc("");
    setComponentQuantity("1");
    setComponentPhotos([]);
    setComponentExpirationDate("");
    setQuantity("1");
    setExpirationDate("");
    setExtraDates([]);
    setFirstDateUnits("");
    if (fileInputRef.current) fileInputRef.current.value = "";
    if (heroFileInputRef.current) heroFileInputRef.current.value = "";
    if (componentFileInputRef.current) componentFileInputRef.current.value = "";
    // Warehouse mode: the box scan field starts empty (the box itself stays
    // picked), and the next stable scale reading fills the weight again.
    setBoxScan("");
    setTypedWeight(false);
    setWeightIsFresh(false);
    setSortPull(null);
    // Shelf location, box size, weight, and isBundle are left as-is — items
    // are usually scanned in batches from the same bin into the same box
    // type (and often the same mode), so keeping the selection saves
    // re-entering it for every item. Jump back to the first step that
    // actually needs fresh input for the next item.
    setStep(isBundle ? "bundleHeroPhoto" : "upc");
  }

  // Fills in everything the relist already knows (the original's UPC,
  // manifest, shelf, box, and these units' count and dates) and goes
  // straight to photos. Weight is left blank: fewer units weigh less.
  function applyRelistPart(plan: RelistPlan, part: RelistPart) {
    const p = plan[part];
    const [first, ...rest] = p.batches;
    setIsBundle(false);
    setUpc(plan.upc ?? "");
    if (preRelistManifest.current === undefined) preRelistManifest.current = activeManifestId;
    if (plan.manifestId) setActiveManifestId(plan.manifestId);
    setIsMultipack(p.isMultipack);
    setPackSize(p.packSize ? String(p.packSize) : "");
    setQuantity(String(p.quantity));
    setExpirationDate(first?.date ?? "");
    setFirstDateUnits(rest.length > 0 && first ? String(first.units) : "");
    setExtraDates(rest.map((b) => ({ date: b.date, units: String(b.units) })));
    setShopifyOnly(part === "past");
    setShelfLocation(plan.shelfLocation);
    setBoxSize(plan.boxSize ?? "");
    setWeightLbs("");
    setWeightOz("");
    setScaleOz(null);
    setTypedWeight(false);
    setWeightIsFresh(false);
    setPhotos([]);
    setRelist({ plan, part });
    setStep("photos");
  }

  // A return listed again in its real condition: the original's UPC,
  // manifest, pack shape and date, the units the return report says to
  // list, Shopify & Whatnot only when that was the call. The condition is
  // set server-side from the return. Straight to new photos.
  function applyReturnPlan(plan: ReturnListingPlan) {
    setIsBundle(false);
    setUpc(plan.upc ?? "");
    if (preRelistManifest.current === undefined) preRelistManifest.current = activeManifestId;
    if (plan.manifestId) setActiveManifestId(plan.manifestId);
    setIsMultipack(plan.isMultipack);
    setPackSize(plan.packSize ? String(plan.packSize) : "");
    setQuantity(String(plan.quantity));
    setExpirationDate(plan.expirationDate ?? "");
    setFirstDateUnits("");
    setExtraDates([]);
    setShopifyOnly(plan.decision === "shopify_only");
    setBoxSize(plan.boxSize ?? "");
    setWeightLbs("");
    setWeightOz("");
    setScaleOz(null);
    setTypedWeight(false);
    setWeightIsFresh(false);
    setPhotos([]);
    setReturnPlan(plan);
    setStep("photos");
  }

  // Ends a relist or a return listing (both are guided, one at a time).
  function endRelist() {
    setRelist(null);
    setReturnPlan(null);
    const previous = preRelistManifest.current;
    preRelistManifest.current = undefined;
    if (previous !== undefined) {
      setActiveManifestId(previous);
      if (previous === null) {
        localStorage.removeItem(ACTIVE_MANIFEST_KEY);
        setManifestTitle(null);
      }
    }
    router.replace("/scan");
  }

  function cancelRelist() {
    resetForm();
    endRelist();
  }

  // --- Warehouse mode: listing from a dud box -------------------------------

  async function loadDudBox(code: string): Promise<DudBoxInfo> {
    const r = await fetch(`/api/dud-boxes/${encodeURIComponent(code)}`, { cache: "no-store" });
    const data = await r.json().catch(() => null);
    if (!r.ok || !data?.box) {
      throw new Error(r.status === 404 ? (data?.error ?? `No dud box with code ${code}.`) : (data?.error ?? `Couldn't load dud box ${code}.`));
    }
    return {
      code: data.box.code,
      manifestId: data.box.manifestId,
      manifestTitle: data.box.manifestTitle ?? null,
      entries: Array.isArray(data.entries) ? data.entries : [],
    };
  }

  async function enterDudBox(raw: string) {
    const code = normalizeCode(raw);
    setDudBoxScan("");
    setMessage(null);
    if (relist || returnPlan) return setMessage("Finish or cancel this relist first.");
    try {
      const box = await loadDudBox(code);
      if (preDudManifest.current === undefined) preDudManifest.current = activeManifestId;
      setActiveManifestId(box.manifestId);
      setDudBox(box);
      setIsBundle(false);
      setUpc("");
      setStep("upc");
    } catch (e) {
      setMessage(e instanceof Error ? e.message : `Couldn't load dud box ${code}.`);
    }
  }

  function leaveDudBox() {
    setDudBox(null);
    const previous = preDudManifest.current;
    preDudManifest.current = undefined;
    if (previous !== undefined) {
      setActiveManifestId(previous);
      if (previous === null) {
        localStorage.removeItem(ACTIVE_MANIFEST_KEY);
        setManifestTitle(null);
      }
    }
    resetForm();
    setMessage(null);
  }

  // UPC step scan: a dud box label switches into dud box mode instead of
  // being taken as a UPC (warehouse mode only).
  function handleUpcScan() {
    if (warehouseMode && classifyScan(upc) === "dudbox") {
      const code = upc;
      setUpc("");
      enterDudBox(code);
      return;
    }
    goNext();
  }

  const steps = warehouseMode
    ? isBundle
      ? WAREHOUSE_BUNDLE_STEPS
      : WAREHOUSE_SINGLE_STEPS
    : isBundle
      ? BUNDLE_STEPS
      : SINGLE_STEPS;
  const stepIndex = steps.indexOf(step);

  // --- Warehouse mode: scale and box ------------------------------------------

  const selectedBox = boxSizes.find((b) => b.label === boxSize);
  const selectedTareOz = boxTareOz(selectedBox);

  // Item weight + empty box, rounded up, into the lb/oz fields that get
  // saved (and that eBay gets).
  function fillPackageWeight(itemOz: number, tareOz: number | null) {
    const { lbs, oz } = packageWeight(itemOz, tareOz);
    setWeightLbs(String(lbs));
    setWeightOz(String(oz));
  }

  function takeScaleWeight(itemOz: number) {
    setScaleOz(itemOz);
    setTypedWeight(false);
    setWeightIsFresh(true);
    fillPackageWeight(itemOz, selectedTareOz);
  }

  // Polled only on the weight step. A settled reading fills the weight by
  // itself unless the weight was typed in by hand for this item.
  const liveWeight = useStationWeight(
    warehouseMode ? (station?.id ?? null) : null,
    warehouseMode && step === "boxWeight",
    (oz) => {
      if (typedWeight) return;
      // Same reading already in: nothing to do (it polls every 700ms).
      if (weightIsFresh && scaleOz != null && Math.abs(oz - scaleOz) < 0.05) return;
      takeScaleWeight(oz);
    }
  );

  // Picking a box (scan or list) re-adds the new box's empty weight to the
  // scale reading, so the math always matches the box on screen. Off mode
  // this is just setBoxSize, same as before.
  function selectBox(label: string) {
    setBoxSize(label);
    if (!warehouseMode || typedWeight || scaleOz == null) return;
    fillPackageWeight(scaleOz, boxTareOz(boxSizes.find((b) => b.label === label)));
  }

  function handleBoxScan() {
    const code = normalizeCode(boxScan);
    if (!code) return;
    setMessage(null);
    const kind = classifyScan(code);
    const box = boxSizes.find((b) => b.code && normalizeCode(b.code) === code);
    if (!box) {
      setMessage(
        kind === "box"
          ? `No box set up with code ${code}. Pick the box from the list instead.`
          : `${code} isn't a box barcode. Box barcodes start with BX.`
      );
      setBoxScan("");
      focusScanField("scan-box");
      return;
    }
    selectBox(box.label);
    // Weight's already in for this item (off the scale or typed): the box
    // scan is the last thing, so it saves, and a normal item is weigh, scan
    // box, done, with no taps. No weight yet = just pick the box and wait;
    // the stale weight from the item before never saves this way.
    // State set above isn't visible to saveItem until the next render, so
    // the box and its recalculated weight are passed in directly.
    if (weightIsFresh && (weightLbs || weightOz)) {
      const weight =
        !typedWeight && scaleOz != null
          ? packageWeight(scaleOz, boxTareOz(box))
          : { lbs: Number(weightLbs) || 0, oz: Number(weightOz) || 0 };
      saveItem({ boxSize: box.label, weightLbs: String(weight.lbs), weightOz: String(weight.oz) });
    }
  }

  function typeWeight(setter: (v: string) => void, value: string) {
    setter(value);
    if (!warehouseMode) return;
    setTypedWeight(true);
    setWeightIsFresh(true);
  }

  async function reprintLabels(copies?: number) {
    if (!lastSaved) return;
    if (!station) {
      setPickingStation(true);
      return;
    }
    setReprinting(true);
    setReprintMessage(null);
    try {
      const res = await fetch(`/api/items/${lastSaved.itemId}/labels`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ stationId: station.id, copies: copies ?? lastSaved.labels }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error ?? "Couldn't reprint.");
      const n = Number(data.labelsQueued) || 0;
      setReprintMessage(`Sent ${n} more label${n === 1 ? "" : "s"} to ${station.name}.`);
    } catch (e) {
      setReprintMessage(e instanceof Error ? e.message : "Couldn't reprint.");
    } finally {
      setReprinting(false);
    }
  }

  function goBack() {
    setMessage(null);
    if (stepIndex > 0) setStep(steps[stepIndex - 1]);
  }

  // Physical units in this scan, what the dated units have to add up to.
  const totalUnits = (Number(quantity) || 1) * (isMultipack ? Number(packSize) || 1 : 1);
  const dateRows = [{ date: expirationDate, units: firstDateUnits }, ...extraDates];
  const datedUnits = dateRows.reduce((sum, r) => sum + (Number(r.units) || 0), 0);

  function datesProblem(): string | null {
    if (extraDates.length === 0) return null;
    if (dateRows.some((r) => !r.date)) return "Every row needs a date.";
    if (dateRows.some((r) => !(Number(r.units) >= 1))) return "Enter how many units have each date.";
    if (datedUnits !== totalUnits) {
      return `Those add up to ${datedUnits} unit${datedUnits === 1 ? "" : "s"}, but this scan is ${totalUnits}.`;
    }
    return null;
  }

  function goNext() {
    setMessage(null);
    if (step === "expiration" && datesProblem()) {
      setMessage(datesProblem());
      return;
    }
    if (step === "quantity" && isMultipack && !packSize) {
      setMessage("Enter a pack size.");
      return;
    }
    if (step === "bundleComponents" && bundleComponents.length === 0) {
      setMessage("Add at least one item to the bundle first.");
      return;
    }
    if (step === "shelfLocation" && !shelfLocation.trim()) {
      setMessage("Scan or enter a shelf location.");
      return;
    }
    // Dud box mode: only what the dud processor marked for Shopify.
    if (step === "upc" && dudBox) {
      const refusal = upc.trim() ? dudBoxRefusal(dudBox, upc.trim()) : "Scan the product's UPC.";
      if (refusal) {
        setMessage(refusal);
        setUpc("");
        focusScanField("scan-upc");
        return;
      }
    }
    if (step === "upc") pullFromSortBoxes(upc.trim());
    if (stepIndex < steps.length - 1) setStep(steps[stepIndex + 1]);
  }

  // Warehouse mode, listing into a manifest: every unit of this product
  // still in a sort box is now at the table (Cristian: no box-by-box
  // scanning). Doesn't hold up the next step; scanning the same product
  // again pulls nothing new. Not for dud box listing (those were never
  // sorted as good). Off mode: never called.
  function pullFromSortBoxes(code: string) {
    if (!warehouseMode || !activeManifestId || !code || dudBox || relist || returnPlan) return;
    const manifestId = activeManifestId;
    fetch("/api/sort-boxes/pull", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ manifestId, upc: code }),
    })
      .then((r) => (r.ok ? r.json() : null))
      .then((data) => {
        if (!data || !Array.isArray(data.pulled)) return;
        setSortPull({ upc: code, pulled: data.pulled, locations: data.locations ?? [] });
      })
      .catch(() => {
        // No sort box info is fine: the lister has the product in hand.
      });
  }

  // "Left some here": puts units back on that box's count.
  async function putBackInBox(boxCode: string, units: number): Promise<string | null> {
    if (!sortPull || !activeManifestId) return "Scan the product again.";
    const r = await fetch("/api/sort-boxes/put-back", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ manifestId: activeManifestId, upc: sortPull.upc, boxCode, units }),
    });
    const data = await r.json().catch(() => ({}));
    if (!r.ok) return data.error ?? "Couldn't put them back.";
    setSortPull((prev) => (prev ? { ...prev, locations: data.locations ?? prev.locations } : prev));
    return null;
  }

  // overrides: warehouse mode's box scan saving in the same moment it
  // picks the box, before that state has rendered.
  async function saveItem(overrides?: { boxSize: string; weightLbs: string; weightOz: string }) {
    // A box scan can arrive while a save is already going (the button is
    // disabled then, a trigger pull isn't).
    if (saving) return;
    setMessage(null);

    // Warehouse mode: a station (where the labels print) instead of a
    // shelf location.
    if (warehouseMode) {
      if (!station) {
        setPickingStation(true);
        return setMessage("Pick this handheld's station first, so the labels print in the right place.");
      }
    } else if (!shelfLocation.trim()) return setMessage("Shelf location is required.");

    if (isBundle) {
      if (bundleComponents.length === 0) {
        return setMessage("Add at least one item to the bundle first.");
      }
      if (heroPhoto?.status === "uploading" || bundleComponents.some((c) => c.photos.some((p) => p.status === "uploading"))) {
        return setMessage("Photos are still uploading, hang on a sec.");
      }
    } else {
      // No gate on UPC — custom/handmade items (e.g. our own t-shirts) have
      // no barcode. Left blank, it exports as "Does Not Apply", eBay's own
      // recognized value for "no identifier applies here."
      if (isMultipack && !packSize) return setMessage("Enter a pack size.");
      const problem = datesProblem();
      if (problem) return setMessage(problem);
      if (photos.some((p) => p.status === "uploading")) {
        return setMessage("Photos are still uploading, hang on a sec.");
      }
    }

    setSaving(true);
    try {
      const res = await fetch("/api/items", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          isBundle,
          upc: isBundle ? undefined : upc.trim() || undefined,
          quantity: Number(quantity) || 1,
          isMultipack: isBundle ? false : isMultipack,
          packSize: !isBundle && isMultipack ? Number(packSize) : null,
          expirationDate: isBundle ? null : expirationDate || null,
          expirationBreakdown:
            !isBundle && extraDates.length > 0
              ? dateRows.map((r) => ({ date: r.date, units: Number(r.units) }))
              : undefined,
          // Off mode sends exactly what it always has (undefined keys are
          // dropped from the JSON).
          shelfLocation: warehouseMode ? undefined : shelfLocation.trim(),
          stationId: warehouseMode ? station?.id : undefined,
          boxSize: (overrides?.boxSize ?? boxSize) || null,
          weightLbs: (overrides?.weightLbs ?? weightLbs) ? Number(overrides?.weightLbs ?? weightLbs) : null,
          weightOz: (overrides?.weightOz ?? weightOz) ? Number(overrides?.weightOz ?? weightOz) : null,
          // The actual eBay listing photos — for a bundle, the hero group
          // shot plus every photo taken of every component, not just the
          // hero, so the buyer has real photos of everything included.
          photoUrls: isBundle
            ? [
                heroPhoto?.cloudinaryUrl,
                ...bundleComponents.flatMap((c) =>
                  c.photos.filter((p) => p.status === "done").map((p) => p.cloudinaryUrl)
                ),
              ].filter((u): u is string => Boolean(u))
            : photos.filter((p) => p.status === "done").map((p) => p.cloudinaryUrl),
          bundleComponents: isBundle
            ? bundleComponents.map((c) => ({
                upc: c.upc,
                quantity: Number(c.quantity) || 1,
                photoUrls: c.photos.filter((p) => p.status === "done").map((p) => p.cloudinaryUrl),
                expirationDate: c.expirationDate || null,
              }))
            : undefined,
          manifestId: activeManifestId,
          // Dud box items are always Shopify & Whatnot only (the server
          // forces it too).
          shopifyOnly: !isBundle && (shopifyOnly || dudBox != null),
          relistOf: relist?.plan.id,
          relistPart: relist?.part,
          returnOf: returnPlan?.id,
          dudBoxCode: dudBox?.code,
        }),
      });

      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        throw new Error(err.error ?? "Save failed.");
      }

      // Draft + category lookup run entirely server-side after this
      // responds (see the after() call in the items POST route) — nothing
      // for the phone to trigger or wait on here, so it's unaffected by the
      // camera app backgrounding the tab between scans.
      setSavedThisSession((n) => n + 1);
      const saved: { id?: string; sku?: string; labelsQueued?: number; relistNext?: RelistPart | null } = await res
        .json()
        .catch(() => ({}));
      if (warehouseMode) {
        setReprintMessage(null);
        setLastSaved(
          saved.id && saved.sku
            ? { itemId: saved.id, code: saved.sku, labels: saved.labelsQueued ?? 0, stationName: station?.name ?? "the station" }
            : null
        );
      }
      resetForm();
      if (relist) {
        const done = { ...relist.plan, [relist.part]: { ...relist.plan[relist.part], done: true } };
        if (saved.relistNext) {
          applyRelistPart(done, saved.relistNext);
          setMessage("Saved the good units. Now the past-date ones.");
        } else {
          endRelist();
          setMessage(
            relist.plan.pastDateLane
              ? "Relist done. Both new listings are in Review."
              : "Relist done. The new listing is in Review, and the past-date units were logged as expired."
          );
        }
      } else if (returnPlan) {
        endRelist();
        setMessage("Saved. The return's new listing is in Review.");
      } else {
        setMessage("Saved. Ready for the next item.");
      }
      // Dud box mode: refresh what's left to list in the box.
      if (dudBox) {
        loadDudBox(dudBox.code)
          .then(setDudBox)
          .catch(() => {
            // Keeps the old counts; the server checks what's left anyway.
          });
      }
    } catch (e) {
      setMessage(e instanceof Error ? e.message : "Something went wrong.");
    } finally {
      setSaving(false);
    }
  }

  // Selling something already on the shelf — no session or manifest needs
  // to be picked first, so this is checked ahead of the start-scanning
  // landing screen below rather than nested inside it.
  if (shelfSaleMode) {
    const packMultiplier = shelfSaleLookup ? walkupPackMultiplier(shelfSaleLookup.alreadyListed, true) : 1;
    return (
      <AppShell
        focused
        width="narrow"
        title="Sell shelf item"
        subtitle="Already on the shelf — scan its shelf location, then its UPC. In-person cash sale, no eBay fees, no shipping."
        actions={
          <BackButton
            onClick={() => {
              setShelfSaleMode(false);
              resetShelfSale();
            }}
          >
            Back
          </BackButton>
        }
      >
        <div className="flex flex-col gap-4">
          {!shelfSaleLookup && (
            <Card className="flex flex-col gap-4">
              <ScanField
                id="shelf-sale-location"
                label="1. Shelf location"
                prompt="Scan the shelf location"
                autoFocus
                value={shelfSaleLocation}
                onChange={setShelfSaleLocation}
                onScan={() => document.getElementById("shelf-sale-upc")?.focus()}
                hint="Scanning moves straight on to the UPC."
              />
              <ScanField
                id="shelf-sale-upc"
                label="2. UPC"
                prompt="Now scan the item's UPC"
                numeric
                value={shelfSaleUpc}
                onChange={setShelfSaleUpc}
                onScan={lookupShelfSaleItem}
                hint="Scanning looks up the price right away."
              />
              <Button variant="outline" size="lg" block onClick={lookupShelfSaleItem} disabled={shelfSaleLooking}>
                <Search className="size-5" aria-hidden />
                {shelfSaleLooking ? "Looking up…" : "Look up price"}
              </Button>
            </Card>
          )}

          {shelfSaleMissed && shelfSaleMessage ? (
            <ScanAgainPanel
              message={shelfSaleMessage}
              tried={`Shelf ${shelfSaleMissed.location} · UPC ${shelfSaleMissed.upc}`}
              readyText="Ready — just scan the UPC again."
              onStartOver={restartShelfSaleScan}
            />
          ) : (
            <Feedback message={shelfSaleMessage} />
          )}

          {shelfSaleLookup && (
            <>
              {shelfSaleLookup.isBundle && (
                <Alert tone="warning">
                  {shelfSaleLookup.note ?? "This UPC is part of a bundle — it has to be sold as the whole bundle."}
                </Alert>
              )}
              <Card>
                <p className="font-semibold leading-snug text-foreground">{shelfSaleLookup.description}</p>
                {shelfSaleLookup.isBundle ? (
                  <p className="mt-1 text-sm text-muted-foreground">
                    Bundle pricing is the listing&apos;s own current price, not a single manifest line.
                    {shelfSaleLookup.currentListedPrice != null && (
                      <> Currently listed at ${shelfSaleLookup.currentListedPrice.toFixed(2)}.</>
                    )}
                  </p>
                ) : shelfSaleLookup.manifestId != null ? (
                  <>
                    <p className="mt-1 text-sm text-muted-foreground">
                      Retail ${shelfSaleLookup.retailPrice?.toFixed(2)}
                      {isOwner && (
                        <>
                          {" "}
                          · COGS{" "}
                          {shelfSaleLookup.landedCostPerUnit != null
                            ? `$${shelfSaleLookup.landedCostPerUnit.toFixed(2)}`
                            : "— enter a landed cost on the manifest to see this"}
                        </>
                      )}
                    </p>
                    <PriceTiers
                      showFloor={isOwner}
                      floorPrice={shelfSaleLookup.floorPrice ?? null}
                      idealPrice={shelfSaleLookup.idealPrice ?? 0}
                      nearExpiryPrice={shelfSaleLookup.nearExpiryPrice ?? 0}
                      packMultiplier={packMultiplier}
                    />
                  </>
                ) : (
                  <p className="mt-1 text-sm text-muted-foreground">
                    This item wasn&apos;t scanned under a manifest, so there&apos;s no floor/ideal pricing breakdown or
                    manifest profit tracking for it — its current eBay listing price is shown as a reference; enter
                    whatever you actually charged.
                    {shelfSaleLookup.currentListedPrice != null && (
                      <> Currently listed at ${shelfSaleLookup.currentListedPrice.toFixed(2)}.</>
                    )}
                  </p>
                )}
              </Card>

              <Alert tone="info">
                {shelfSaleLookup.alreadyListed.isMultipack && shelfSaleLookup.alreadyListed.packSize
                  ? `${shelfSaleLookup.alreadyListed.availableQuantity} pack(s) of ${shelfSaleLookup.alreadyListed.packSize} available on eBay (${
                      shelfSaleLookup.alreadyListed.availableQuantity * shelfSaleLookup.alreadyListed.packSize
                    } units total)`
                  : `${shelfSaleLookup.alreadyListed.availableQuantity} available on eBay`}
                . Selling this reduces that listing.
              </Alert>

              <CounterSaleCheckout
                target={{
                  kind: "shelf",
                  manifestId: shelfSaleLookup.manifestId,
                  itemId: shelfSaleLookup.itemId,
                  upc: shelfSaleUpc.trim(),
                  binCode: shelfSaleLookup.binCode ?? null,
                }}
                onDone={(text) => {
                  resetShelfSale();
                  setShelfSaleMessage(`${text} Scan the next shelf location.`);
                  focusScanField("shelf-sale-location");
                }}
                onCancel={resetShelfSale}
              />
            </>
          )}
        </div>
      </AppShell>
    );
  }

  if (!scanning) {
    return (
      <AppShell width="narrow" title="List inventory" subtitle="Start listing, or sell something already on the shelf.">
        <div className="flex flex-col gap-3">
          <OptionCard
            primary
            icon={ScanBarcode}
            title="Start scanning"
            description="Photograph, scan, and shelve items for listing."
            onClick={startScanning}
          />
          <OptionCard
            href="/manifests"
            icon={FileSpreadsheet}
            title="Scan with a manifest"
            description="Pick or upload a manifest to reconcile against as you go."
          />
          <OptionCard
            icon={ShoppingBag}
            title="Sell shelf item"
            description="Walk-up customer buying something already listed."
            onClick={() => setShelfSaleMode(true)}
          />

        </div>
      </AppShell>
    );
  }

  // Sorting-only path — no photos, no listing, just a tally of bad units
  // against the manifest. Separate from the normal item wizard entirely.
  if (damagedMode) {
    return (
      <AppShell
        focused
        width="narrow"
        title="Damaged / expired"
        subtitle={manifestTitle ? `Manifest: ${manifestTitle}` : undefined}
        actions={<BackButton onClick={() => setDamagedMode(false)}>Back to scanning</BackButton>}
      >
        <Card className="flex flex-col gap-4">
          <ScanField
            id="damaged-upc"
            label="UPC"
            prompt="Scan the damaged/expired item"
            numeric
            autoFocus
            value={damagedUpc}
            onChange={setDamagedUpc}
            onScan={saveDamagedEntry}
            hint="Logs the moment it scans, using the quantity below — change that first if it's more than 1."
          />
          <Field label="Quantity bad">
            <Input
              size="lg"
              type="number"
              min={1}
              value={damagedQuantity}
              onChange={(e) => setDamagedQuantity(e.target.value)}
              onWheel={(e) => e.currentTarget.blur()}
            />
          </Field>
          <Feedback message={damagedMessage} />
          <Button variant="danger" size="xl" block onClick={saveDamagedEntry} disabled={damagedSaving}>
            <PackageX className="size-5" aria-hidden />
            {damagedSaving ? "Logging…" : "Log damaged/expired"}
          </Button>
        </Card>
      </AppShell>
    );
  }

  // Same sorting-only path as damagedMode above — physically arrived fine,
  // just never getting listed (dead event merch, no resale value, etc.).
  // Still counts as "accounted for" on the manifest, just not "received"
  // in the sense of ever going through review/eBay.
  if (dudMode) {
    return (
      <AppShell
        focused
        width="narrow"
        title="Dud / unsellable"
        subtitle="Arrived fine but not being listed — dead event merch, no resale value, etc. Not damaged/expired."
        actions={<BackButton onClick={() => setDudMode(false)}>Back to scanning</BackButton>}
      >
        {manifestTitle && <p className="-mt-2 mb-4 text-sm text-muted-foreground">Manifest: {manifestTitle}</p>}
        <Card className="flex flex-col gap-4">
          <ScanField
            id="dud-upc"
            label="UPC"
            prompt="Scan the unsellable item"
            numeric
            autoFocus
            value={dudUpc}
            onChange={setDudUpc}
            onScan={saveDudEntry}
            hint="Logs the moment it scans, using the quantity below — change that first if it's more than 1."
          />
          <Field label="Quantity not sellable">
            <Input
              size="lg"
              type="number"
              min={1}
              value={dudQuantity}
              onChange={(e) => setDudQuantity(e.target.value)}
              onWheel={(e) => e.currentTarget.blur()}
            />
          </Field>
          <Feedback message={dudMessage} />
          <Button
            size="xl"
            block
            onClick={saveDudEntry}
            disabled={dudSaving}
            variant="warning"
          >
            <Ban className="size-5" aria-hidden />
            {dudSaving ? "Logging…" : "Log dud/unsellable"}
          </Button>
        </Card>
      </AppShell>
    );
  }

  // In-person cash sale, right now — scan a UPC on this manifest, get an
  // instant floor/ideal/near-expiry price with no math required, mark it
  // sold, then straight back to the UPC step for the next item.
  if (walkupMode) {
    const packMultiplier = walkupLookup
      ? walkupPackMultiplier(walkupLookup.alreadyListed, walkupAlreadyInventoried)
      : 1;
    return (
      <AppShell
        focused
        width="narrow"
        title="Walk-up sale"
        subtitle="In-person cash sale, right now — no eBay fees, no shipping."
        actions={
          <BackButton
            onClick={() => {
              setWalkupMode(false);
              resetWalkupSale();
            }}
          >
            Back to scanning
          </BackButton>
        }
      >
        {manifestTitle && <p className="-mt-2 mb-4 text-sm text-muted-foreground">Manifest: {manifestTitle}</p>}
        <div className="flex flex-col gap-4">
          {!walkupLookup && (
            <Card className="flex flex-col gap-4">
              <ScanField
                id="walkup-upc"
                label="UPC"
                prompt="Scan the item's UPC"
                numeric
                autoFocus
                value={walkupUpc}
                onChange={setWalkupUpc}
                onScan={lookupWalkupUpc}
                hint="Scanning looks up the price right away."
              />
              <Button variant="outline" size="lg" block onClick={lookupWalkupUpc} disabled={walkupLooking}>
                <Search className="size-5" aria-hidden />
                {walkupLooking ? "Looking up…" : "Look up price"}
              </Button>
            </Card>
          )}

          {walkupMissedUpc && walkupMessage ? (
            <ScanAgainPanel
              message={walkupMessage}
              tried={`UPC ${walkupMissedUpc}`}
              readyText="Ready — just scan the UPC again."
            />
          ) : (
            <Feedback message={walkupMessage} />
          )}

          {walkupLookup && (
            <>
              <Card>
                <p className="font-semibold leading-snug text-foreground">{walkupLookup.description}</p>
                <p className="mt-1 text-sm text-muted-foreground">
                  Retail ${walkupLookup.retailPrice.toFixed(2)}
                  {isOwner && (
                    <>
                      {" "}
                      · COGS{" "}
                      {walkupLookup.landedCostPerUnit != null
                        ? `$${walkupLookup.landedCostPerUnit.toFixed(2)}`
                        : "— enter a landed cost on the manifest to see this"}
                    </>
                  )}
                </p>
                <PriceTiers
                  showFloor={isOwner}
                  floorPrice={walkupLookup.floorPrice}
                  idealPrice={walkupLookup.idealPrice}
                  nearExpiryPrice={walkupLookup.nearExpiryPrice}
                  packMultiplier={packMultiplier}
                />
              </Card>

              {walkupLookup.alreadyListed && (
                <CheckboxRow
                  label="Already inventoried"
                  description={`${
                    walkupLookup.alreadyListed.isMultipack && walkupLookup.alreadyListed.packSize
                      ? `${walkupLookup.alreadyListed.availableQuantity} pack(s) of ${walkupLookup.alreadyListed.packSize} available on eBay (${
                          walkupLookup.alreadyListed.availableQuantity * walkupLookup.alreadyListed.packSize
                        } units total)`
                      : `${walkupLookup.alreadyListed.availableQuantity} available on eBay`
                  }. Reduce that listing instead of logging a fresh receive.`}
                  checked={walkupAlreadyInventoried}
                  onChange={(e) => setWalkupAlreadyInventoried(e.target.checked)}
                />
              )}

              <CounterSaleCheckout
                target={{
                  kind: "walkup",
                  manifestId: activeManifestId,
                  itemId: walkupAlreadyInventoried ? (walkupLookup.alreadyListed?.itemId ?? null) : null,
                  upc: walkupUpc.trim(),
                }}
                onDone={(text) => {
                  resetWalkupSale();
                  setWalkupMessage(text);
                  focusScanField("walkup-upc");
                }}
                onCancel={resetWalkupSale}
              />
            </>
          )}
        </div>
      </AppShell>
    );
  }

  const isLastStep = stepIndex === steps.length - 1;

  // Warehouse mode: one label per sellable unit, so a multi-pack counts
  // in bags and a bundle in whole bundles.
  const labelUnits = Number(quantity) || 1;
  const labelUnitWord = isBundle ? "bundle" : isMultipack ? `${packSize || "multi"}-pack bag` : "unit";

  return (
    <AppShell
      focused
      width="narrow"
      title="Listing"
      subtitle={`${savedThisSession} saved`}
      actions={
        <>
          <Link href="/review" className={buttonClasses({ variant: "outline", size: "sm" })}>
            Review
          </Link>
          <Button variant="danger-ghost" size="sm" onClick={finishScanning}>
            Finish
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-4">
        {activeManifestId && (
          <Card padded={false} className="p-3">
            <div className="mb-3 flex items-center justify-between gap-2 px-1">
              <p className="min-w-0 truncate text-sm">
                <span className="text-muted-foreground">Manifest </span>
                <span className="font-medium text-foreground">{manifestTitle ?? "…"}</span>
              </p>
              <Link
                href={`/manifests/${activeManifestId}`}
                className="shrink-0 text-sm font-medium text-primary hover:underline"
              >
                Open
              </Link>
            </div>
            <div className="grid grid-cols-3 gap-2">
              <ModeTile icon={PackageX} tone="danger" label="Damaged / expired" onClick={() => setDamagedMode(true)} />
              <ModeTile icon={Ban} tone="warning" label="Dud / unsellable" onClick={() => setDudMode(true)} />
              <ModeTile icon={ShoppingBag} tone="success" label="Walk-up sale" onClick={() => setWalkupMode(true)} />
            </div>
          </Card>
        )}

        {modeUnknown && (
          <Alert tone="warning">
            Couldn&apos;t check if warehouse mode is on, so this is the regular flow (shelf location, no labels).
            Reload to check again.
          </Alert>
        )}

        {warehouseMode &&
          (pickingStation || stationChoice.needsStation || stationChoice.error ? (
            <StationPicker
              stations={stationChoice.stations}
              selectedId={station?.id ?? null}
              error={stationChoice.error}
              onReload={stationChoice.reload}
              onPick={(s) => {
                stationChoice.choose(s.id);
                setPickingStation(false);
                setMessage(null);
              }}
              onCancel={station ? () => setPickingStation(false) : undefined}
            />
          ) : (
            station && (
              <div className="flex items-center justify-between gap-2 rounded-xl border border-border bg-surface px-3 py-2 text-sm shadow-sm">
                <span className="flex min-w-0 items-center gap-2">
                  <span className="text-muted-foreground">Station</span>
                  <span className="truncate font-medium text-foreground">{station.name}</span>
                  <StationOnline online={liveWeight.status?.online ?? station.online} />
                </span>
                <button
                  type="button"
                  className="shrink-0 text-sm font-medium text-primary hover:underline"
                  onClick={() => setPickingStation(true)}
                >
                  Change
                </button>
              </div>
            )
          ))}

        {warehouseMode && lastSaved && (
          <div className="rounded-xl border border-green-200 bg-green-50 px-3 py-2.5 text-sm text-green-950">
            <div className="flex items-start gap-2">
              <Printer className="mt-0.5 size-5 shrink-0 text-green-600" aria-hidden />
              <div className="min-w-0 flex-1">
                <p className="font-semibold">
                  {lastSaved.labels === 1
                    ? `Printing 1 label at ${lastSaved.stationName}. Bag it and stick the label on it.`
                    : `Printing ${lastSaved.labels} labels at ${lastSaved.stationName}. Bag each unit and stick a label on it.`}
                </p>
                <p className="mt-0.5 tabular-nums text-green-900">Item code {lastSaved.code}</p>
                {reprintMessage && <p className="mt-1 text-green-900">{reprintMessage}</p>}
              </div>
              <button
                type="button"
                onClick={() => setLastSaved(null)}
                aria-label="Hide"
                className="grid size-7 shrink-0 place-items-center rounded-md text-green-800 hover:bg-green-100"
              >
                <X className="size-4" aria-hidden />
              </button>
            </div>
            <div className="mt-2 flex gap-2">
              <Button variant="outline" size="sm" onClick={() => reprintLabels()} disabled={reprinting}>
                <Printer className="size-4" aria-hidden />
                {reprinting ? "Sending…" : lastSaved.labels > 1 ? `Reprint all ${lastSaved.labels}` : "Reprint"}
              </Button>
              {lastSaved.labels > 1 && (
                <Button variant="outline" size="sm" onClick={() => reprintLabels(1)} disabled={reprinting}>
                  Reprint 1
                </Button>
              )}
            </div>
          </div>
        )}

        {warehouseMode && sortPull && sortPull.upc === upc.trim() && step !== "mode" && step !== "upc" && (
          <SortBoxesCard pull={sortPull} onPutBack={putBackInBox} />
        )}

        <StepProgress current={stepIndex} total={steps.length} />

        {relist && (
          <div className="rounded-xl border border-sky-200 bg-sky-50 px-3 py-2.5 text-sm text-sky-950">
            <div className="flex items-start justify-between gap-2">
              <p className="font-semibold">
                Relisting
                {relist.plan.pastDateLane ? ` · part ${relist.part === "good" ? 1 : 2} of 2` : ""}
              </p>
              <button type="button" className="shrink-0 text-xs font-medium underline" onClick={cancelRelist}>
                Cancel
              </button>
            </div>
            <p className="mt-0.5 text-sky-900">{relist.plan.title}</p>
            <p className="mt-1.5">
              {relist.part === "good" ? (
                <>
                  <strong>Still-good units</strong> ({describeBreakdown(relist.plan.good.batches)}). Set the past-date
                  ones aside and take new photos of just these. They go back on eBay.
                  {!relist.plan.pastDateLane &&
                    ` The past-date ones (${describeBreakdown(relist.plan.past.batches)}) can't be resold, so they get logged as expired when you save. Toss them.`}
                </>
              ) : (
                <>
                  <strong>Past-date units</strong> ({describeBreakdown(relist.plan.past.batches)}). Take new photos of
                  just these. They go on Shopify &amp; Whatnot only, on the past-date deals page.
                </>
              )}
            </p>
          </div>
        )}

        {returnPlan && (
          <div className="rounded-xl border border-sky-200 bg-sky-50 px-3 py-2.5 text-sm text-sky-950">
            <div className="flex items-start justify-between gap-2">
              <p className="font-semibold">
                Listing a return
                {returnPlan.decision === "shopify_only" ? " · Shopify & Whatnot only" : ""}
              </p>
              <button type="button" className="shrink-0 text-xs font-medium underline" onClick={cancelRelist}>
                Cancel
              </button>
            </div>
            <p className="mt-0.5 text-sky-900">{returnPlan.title}</p>
            <p className="mt-1.5">
              <strong>{returnPlan.summary}.</strong> Take new photos of exactly what goes in this listing, show any damage.
              It gets listed as {RETURN_CONDITION_TEXT[returnPlan.condition] ?? returnPlan.condition}.
            </p>
            {returnPlan.steps.length > 0 && <p className="mt-1 text-sky-900">{returnPlan.steps.join(" ")}</p>}
          </div>
        )}

        {dudBox && (
          <div className="flex flex-wrap items-center justify-between gap-2 rounded-xl border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-950">
            <span className="min-w-0">
              Listing from dud box <span className="font-semibold">{dudBox.code}</span>
              {dudBox.manifestTitle ? ` (${dudBox.manifestTitle})` : ""}
            </span>
            <button type="button" className="text-xs font-medium underline" onClick={leaveDudBox}>
              Leave dud box
            </button>
          </div>
        )}

        {shopifyOnly && !relist && !returnPlan && !dudBox && !isBundle && step !== "mode" && step !== "upc" && (
          <div className="flex flex-wrap items-center justify-between gap-2 rounded-xl border border-violet-200 bg-violet-50 px-3 py-2 text-sm text-violet-950">
            <span>
              <span className="font-semibold">Shopify &amp; Whatnot only.</span> This one won&apos;t be listed on eBay.
            </span>
            <button type="button" className="text-xs font-medium underline" onClick={() => setShopifyOnly(false)}>
              List on eBay instead
            </button>
          </div>
        )}

        {step === "mode" && (
          <section className="flex flex-col gap-3">
            {warehouseMode && !relist && !returnPlan && !dudBox && (
              <Card>
                <ScanField
                  id="scan-dud-box"
                  label="Listing from a dud box?"
                  prompt="Scan the dud box label (DB...)"
                  autoFocus
                  value={dudBoxScan}
                  onChange={setDudBoxScan}
                  onScan={() => {
                    if (classifyScan(dudBoxScan) !== "dudbox") {
                      setMessage(`${normalizeCode(dudBoxScan)} isn't a dud box label. Dud box labels start with DB.`);
                      setDudBoxScan("");
                      focusScanField("scan-dud-box");
                      return;
                    }
                    enterDudBox(dudBoxScan);
                  }}
                  hint="Otherwise pick Single item or Bundle below."
                />
              </Card>
            )}
            <p className="text-sm font-medium text-foreground">What are you scanning?</p>
            <OptionCard
              icon={Package}
              title="Single item"
              description="One product, or a multi-pack of the same product."
              onClick={() => {
                setIsBundle(false);
                setStep("upc");
              }}
            />
            <OptionCard
              icon={Boxes}
              title="Bundle"
              description="Several different products sold together as one listing."
              onClick={() => {
                setIsBundle(true);
                setStep("bundleHeroPhoto");
              }}
            />
          </section>
        )}

        {step === "photos" && (
          <Card>
            <SectionHeader title="Photos" description="Add as many as you need." />
            <div className="grid grid-cols-3 gap-2 sm:grid-cols-4">
              {photos.map((p) => (
                <PhotoTile key={p.id} photo={p} onRemove={() => removePhoto(p.id)} />
              ))}
              <AddPhotoTile onClick={() => fileInputRef.current?.click()} />
            </div>
            <input
              ref={fileInputRef}
              type="file"
              accept="image/*"
              capture="environment"
              multiple
              className="hidden"
              onChange={(e) => handleFiles(e.target.files)}
            />
          </Card>
        )}

        {step === "upc" && (
          <Card>
            <ScanField
              id="scan-upc"
              label="UPC"
              prompt="Scan the item's UPC"
              numeric
              autoFocus
              value={upc}
              onChange={setUpc}
              onScan={handleUpcScan}
              hint="Scanning moves on by itself. Optional — tap Next to skip for custom/handmade items."
              trailing={
                <CameraButton
                  onClick={() => {
                    setScanTarget("item");
                    setShowScanner(true);
                  }}
                />
              }
            />
          </Card>
        )}

        {step === "quantity" && (
          <Card className="flex flex-col gap-4">
            {upc.trim() && (
              <PackSuggestionCard
                upc={upc.trim()}
                manifestId={activeManifestId}
                onApply={(size, listings) => {
                  setIsMultipack(size > 1);
                  setPackSize(size > 1 ? String(size) : "");
                  if (listings != null) setQuantity(String(listings));
                }}
                onSetAside={resetForm}
                onShopifyOnly={(size, listings) => {
                  setShopifyOnly(true);
                  setIsMultipack(size > 1);
                  setPackSize(size > 1 ? String(size) : "");
                  if (listings != null) setQuantity(String(listings));
                }}
              />
            )}
            <CheckboxRow
              label="Multi-pack"
              description="Several units of the same product sold together as one listing."
              checked={isMultipack}
              onChange={(e) => setIsMultipack(e.target.checked)}
            />
            {isMultipack && (
              <Field label="Pack size">
                <Input
                  size="lg"
                  type="number"
                  min={2}
                  value={packSize}
                  onChange={(e) => setPackSize(e.target.value)}
                  onWheel={(e) => e.currentTarget.blur()}
                  placeholder="e.g. 3"
                />
              </Field>
            )}
            <Field label="Quantity">
              <Input
                size="lg"
                type="number"
                min={1}
                value={quantity}
                onChange={(e) => setQuantity(e.target.value)}
                onWheel={(e) => e.currentTarget.blur()}
              />
            </Field>
          </Card>
        )}

        {step === "expiration" && (
          <Card>
            {extraDates.length === 0 ? (
              <Field label="Expiration date" hint="Optional — leave blank if it doesn't expire.">
                <Input size="lg" type="date" value={expirationDate} onChange={(e) => setExpirationDate(e.target.value)} />
              </Field>
            ) : (
              <div className="flex flex-col gap-3">
                <p className="text-sm text-muted-foreground">
                  Enter each date and how many units have it. The listing uses the earliest date, and the description lists
                  them all.
                </p>
                {dateRows.map((row, i) => (
                  <div key={i} className="rounded-lg border border-border p-3">
                    <div className="mb-2 flex items-center justify-between">
                      <span className="text-sm font-medium text-foreground">Date {i + 1}</span>
                      {i > 0 && (
                        <button
                          type="button"
                          onClick={() => {
                            setExtraDates((prev) => prev.filter((_, j) => j !== i - 1));
                            if (extraDates.length === 1) setFirstDateUnits("");
                          }}
                          className="inline-flex items-center gap-1 text-sm font-medium text-danger hover:underline"
                        >
                          <X className="size-4" aria-hidden />
                          Remove
                        </button>
                      )}
                    </div>
                    <div className="grid grid-cols-[1fr_6.5rem] gap-2">
                      <Input
                        size="lg"
                        type="date"
                        aria-label={`Date ${i + 1}`}
                        value={row.date}
                        onChange={(e) =>
                          i === 0
                            ? setExpirationDate(e.target.value)
                            : setExtraDates((prev) => prev.map((r, j) => (j === i - 1 ? { ...r, date: e.target.value } : r)))
                        }
                      />
                      <Input
                        size="lg"
                        type="number"
                        min={1}
                        inputMode="numeric"
                        aria-label={`Units with date ${i + 1}`}
                        placeholder="Units"
                        value={row.units}
                        onChange={(e) =>
                          i === 0
                            ? setFirstDateUnits(e.target.value)
                            : setExtraDates((prev) => prev.map((r, j) => (j === i - 1 ? { ...r, units: e.target.value } : r)))
                        }
                        onWheel={(e) => e.currentTarget.blur()}
                      />
                    </div>
                  </div>
                ))}
                <p className={cn("text-sm tabular-nums", datedUnits === totalUnits ? "text-muted-foreground" : "text-warning")}>
                  {datedUnits} of {totalUnits} unit{totalUnits === 1 ? "" : "s"} dated
                </p>
              </div>
            )}
            <button
              type="button"
              onClick={() => setExtraDates((prev) => [...prev, { date: "", units: "" }])}
              className="mt-3 inline-flex items-center gap-1 text-sm font-medium text-primary hover:underline"
            >
              <Plus className="size-4" aria-hidden />
              {extraDates.length === 0 ? "Some units have a different date" : "Add another date"}
            </button>
          </Card>
        )}

        {step === "bundleHeroPhoto" && (
          <Card>
            <SectionHeader title="Bundle photo" description="Everything together — the main listing photo." />
            <div className="grid grid-cols-3 gap-2 sm:grid-cols-4">
              {heroPhoto ? (
                <PhotoTile photo={heroPhoto} onRemove={() => setHeroPhoto(null)} />
              ) : (
                <AddPhotoTile onClick={() => heroFileInputRef.current?.click()} />
              )}
            </div>
            <input
              ref={heroFileInputRef}
              type="file"
              accept="image/*"
              capture="environment"
              className="hidden"
              onChange={(e) => {
                const file = e.target.files?.[0];
                if (file) startSinglePhotoUpload(file, setHeroPhoto);
              }}
            />
          </Card>
        )}

        {step === "bundleComponents" && (
          <>
            <Card className="flex flex-col gap-4">
              <SectionHeader
                className="mb-0"
                title="Add an item to this bundle"
                description="Photo(s) first, then scan its UPC — scanning adds it right away."
              />
              <div className="grid grid-cols-4 gap-2">
                {componentPhotos.map((p) => (
                  <PhotoTile key={p.id} photo={p} onRemove={() => removeComponentPhoto(p.id)} />
                ))}
                <AddPhotoTile onClick={() => componentFileInputRef.current?.click()} />
              </div>
              <input
                ref={componentFileInputRef}
                type="file"
                accept="image/*"
                capture="environment"
                multiple
                className="hidden"
                onChange={(e) => handleComponentFiles(e.target.files)}
              />
              {/* Scanning a component's UPC adds it to the bundle right
                  away, so the loop of "photo(s) already taken, scan UPC" is
                  one trigger-pull per item instead of also tapping Add. */}
              <ScanField
                id="scan-component-upc"
                label="UPC"
                prompt="Scan this item's UPC"
                numeric
                value={componentUpc}
                onChange={setComponentUpc}
                onScan={addBundleComponent}
                hint="Scanning adds it to the bundle — set qty/expiration below first if needed."
                trailing={
                <CameraButton
                  onClick={() => {
                    setScanTarget("component");
                    setShowScanner(true);
                  }}
                />
                }
              />
              <div className="grid grid-cols-[6rem_1fr] gap-3">
                <Field label="Qty">
                  <Input
                    type="number"
                    min={1}
                    value={componentQuantity}
                    onChange={(e) => setComponentQuantity(e.target.value)}
                    onWheel={(e) => e.currentTarget.blur()}
                  />
                </Field>
                <Field label="Expiration (optional)">
                  <Input
                    type="date"
                    value={componentExpirationDate}
                    onChange={(e) => setComponentExpirationDate(e.target.value)}
                  />
                </Field>
              </div>
              <Button
                variant="secondary"
                size="lg"
                block
                onClick={addBundleComponent}
                disabled={!componentUpc.trim() || componentPhotos.some((p) => p.status === "uploading")}
              >
                <Plus className="size-5" aria-hidden />
                Add to bundle
              </Button>
            </Card>

            {bundleComponents.length > 0 && (
              <section>
                <SectionHeader title="In this bundle" action={<Badge tone="primary">{bundleComponents.length}</Badge>} />
                <ul className="flex flex-col gap-2">
                  {bundleComponents.map((c) => (
                    <li
                      key={c.id}
                      className="flex items-center gap-3 rounded-xl border border-border bg-surface p-3 shadow-sm"
                    >
                      {c.photos.length > 0 && (
                        <div className="flex shrink-0 -space-x-3">
                          {c.photos.slice(0, 3).map((p) => (
                            <img
                              key={p.id}
                              src={p.previewUrl}
                              alt=""
                              className="size-10 rounded-lg border-2 border-surface object-cover"
                            />
                          ))}
                        </div>
                      )}
                      <div className="min-w-0 flex-1 text-sm">
                        <p className="truncate font-medium tabular-nums text-foreground">UPC {c.upc}</p>
                        <p className="text-muted-foreground">
                          Qty {c.quantity}
                          {c.expirationDate && ` · exp ${c.expirationDate}`}
                        </p>
                      </div>
                      <button
                        type="button"
                        onClick={() => removeBundleComponent(c.id)}
                        aria-label={`Remove UPC ${c.upc}`}
                        className="grid size-10 shrink-0 place-items-center rounded-lg text-muted-foreground hover:bg-red-50 hover:text-danger"
                      >
                        <Trash2 className="size-5" aria-hidden />
                      </button>
                    </li>
                  ))}
                </ul>
              </section>
            )}
          </>
        )}

        {step === "bundleQuantity" && (
          <Card>
            <Field label="How many of this bundle do you have?">
              <Input
                size="lg"
                type="number"
                min={1}
                value={quantity}
                onChange={(e) => setQuantity(e.target.value)}
                onWheel={(e) => e.currentTarget.blur()}
              />
            </Field>
          </Card>
        )}

        {step === "shelfLocation" && (
          <Card>
            <ScanField
              id="scan-shelf-location"
              label="Shelf location"
              prompt="Scan the shelf location"
              autoFocus
              list="shelf-location-suggestions"
              value={shelfLocation}
              onChange={setShelfLocation}
              onScan={goNext}
              hint="Scanning moves on by itself."
              trailing={
                <CameraButton
                  onClick={() => {
                    setScanTarget("location");
                    setShowScanner(true);
                  }}
                />
              }
            />
            <datalist id="shelf-location-suggestions">
              {shelfLocations.map((loc) => (
                <option key={loc.id} value={loc.label} />
              ))}
            </datalist>
          </Card>
        )}

        {step === "boxWeight" && warehouseMode && (
          <Card className="flex flex-col gap-4">
            <SectionHeader
              className="mb-0"
              title="Weigh it and pick the box"
              description={
                isBundle
                  ? "Put one whole bundle on the scale."
                  : isMultipack
                    ? `Put one ${packSize || "multi"}-pack on the scale: the whole bag, not one piece.`
                    : "Put one unit on the scale."
              }
            />
            {station ? (
              <LiveWeightReadout
                status={liveWeight.status}
                error={liveWeight.error}
                onUse={(oz) => {
                  takeScaleWeight(oz);
                  // The tap took focus off the box field; put it back so
                  // the next trigger pull still lands there.
                  focusScanField("scan-box");
                }}
              />
            ) : (
              <Alert
                tone="warning"
                action={
                  <Button variant="outline" size="sm" onClick={() => setPickingStation(true)}>
                    Pick a station
                  </Button>
                }
              >
                Pick this handheld&apos;s station to get the live weight. Or type it in below.
              </Alert>
            )}

            <ScanField
              id="scan-box"
              label="Box"
              prompt="Scan the box size barcode"
              autoFocus
              value={boxScan}
              onChange={setBoxScan}
              onScan={handleBoxScan}
              hint="Scanning the box saves the item once the weight is in."
            />
            <Field
              label="Or pick the box"
              hint={
                boxSizes.length === 0 ? (
                  <Link href="/settings" className="font-medium text-primary hover:underline">
                    Add box sizes in Settings
                  </Link>
                ) : undefined
              }
            >
              <Select value={boxSize} onChange={(e) => selectBox(e.target.value)}>
                <option value="">Select box size…</option>
                {boxSizes.map((b) => (
                  <option key={b.id} value={b.label}>
                    {b.label}
                    {b.code ? ` (${b.code})` : ""}
                  </option>
                ))}
              </Select>
            </Field>
            {selectedBox && (
              <p className="-mt-2 text-sm text-muted-foreground">
                Box <span className="font-medium text-foreground">{selectedBox.label}</span>
                {selectedTareOz != null ? `, empty ${formatOz(selectedTareOz)}` : ", no empty weight set (not added)"}
              </p>
            )}

            <div>
              <p className="mb-1.5 text-sm font-medium text-foreground">
                {isBundle ? "Package weight (whole bundle in its box)" : "Package weight (in its box)"}
              </p>
              <div className="grid grid-cols-2 gap-3">
                <UnitInput
                  unit="lb"
                  min={0}
                  value={weightLbs}
                  onChange={(e) => typeWeight(setWeightLbs, e.target.value)}
                  onWheel={(e) => e.currentTarget.blur()}
                />
                <UnitInput
                  unit="oz"
                  min={0}
                  max={15}
                  value={weightOz}
                  onChange={(e) => typeWeight(setWeightOz, e.target.value)}
                  onWheel={(e) => e.currentTarget.blur()}
                />
              </div>
              {scaleOz != null && !typedWeight && (weightLbs || weightOz) ? (
                <p className="mt-1.5 text-sm tabular-nums text-muted-foreground">
                  {(() => {
                    const pkg = packageWeight(scaleOz, selectedTareOz);
                    const total = formatLbOz(pkg.lbs, pkg.oz);
                    return selectedTareOz != null
                      ? `${formatOz(scaleOz)} item + ${formatOz(selectedTareOz)} box = ${total}`
                      : `${formatOz(scaleOz)} item = ${total}${selectedBox ? "" : " (no box picked yet)"}`;
                  })()}
                </p>
              ) : typedWeight ? (
                <p className="mt-1.5 text-xs text-muted-foreground">
                  Typed in, so the scale won&apos;t change it.{" "}
                  {liveWeight.status?.online && (
                    <button
                      type="button"
                      className="font-medium text-primary hover:underline"
                      onClick={() => {
                        const reading = liveWeight.status?.weightOz;
                        if (reading != null && reading > 0) takeScaleWeight(reading);
                        else setTypedWeight(false);
                      }}
                    >
                      Use the scale again
                    </button>
                  )}
                </p>
              ) : null}
              {!weightIsFresh && (weightLbs || weightOz) && (
                <p className="mt-1.5 text-xs font-medium text-warning">
                  Still the last item&apos;s weight. Put this one on the scale if it&apos;s different.
                </p>
              )}
            </div>
            <p className="text-sm text-muted-foreground">
              Saving prints {labelUnits} label{labelUnits === 1 ? "" : "s"}
              {station ? ` at ${station.name}` : ""}, one per {labelUnitWord}.
            </p>
          </Card>
        )}

        {step === "boxWeight" && !warehouseMode && (
          <Card className="flex flex-col gap-4">
            <Field
              label={isBundle ? "Box size (whole bundle)" : "Box size"}
              hint={
                boxSizes.length === 0 ? (
                  <Link href="/settings" className="font-medium text-primary hover:underline">
                    Add box sizes in Settings
                  </Link>
                ) : undefined
              }
            >
              <Select value={boxSize} onChange={(e) => setBoxSize(e.target.value)}>
                <option value="">Select box size…</option>
                {boxSizes.map((b) => (
                  <option key={b.id} value={b.label}>
                    {b.label}
                  </option>
                ))}
              </Select>
            </Field>
            <div>
              <p className="mb-1.5 text-sm font-medium text-foreground">
                {isBundle ? "Weight (whole bundle)" : "Weight"}
              </p>
              <div className="grid grid-cols-2 gap-3">
                <UnitInput
                  unit="lb"
                  min={0}
                  value={weightLbs}
                  onChange={(e) => setWeightLbs(e.target.value)}
                  onWheel={(e) => e.currentTarget.blur()}
                />
                <UnitInput
                  unit="oz"
                  min={0}
                  max={15}
                  value={weightOz}
                  onChange={(e) => setWeightOz(e.target.value)}
                  onWheel={(e) => e.currentTarget.blur()}
                />
              </div>
            </div>
          </Card>
        )}

        <Feedback message={message} />

        {/* Clears the fixed Back/Next bar below so the last field isn't
            hidden behind it. */}
        {step !== "mode" && <div className="h-20" aria-hidden />}
      </div>

      {/* The mode step's two big option cards ARE its navigation — no
          generic Next button needed (or wanted) there. */}
      {step !== "mode" && (
        <div
          className="fixed inset-x-0 bottom-0 z-30 border-t border-border bg-surface/95 backdrop-blur"
          style={{ paddingBottom: "env(safe-area-inset-bottom)" }}
        >
          <div className="mx-auto flex max-w-lg gap-3 px-4 py-3">
            {stepIndex > 0 && (
              <Button variant="outline" size="xl" onClick={goBack} className="w-28 shrink-0">
                <ArrowLeft className="size-5" aria-hidden />
                Back
              </Button>
            )}
            <Button size="xl" block onClick={isLastStep ? () => saveItem() : goNext} disabled={saving}>
              {isLastStep ? (
                saving ? (
                  "Saving…"
                ) : (
                  <>
                    <Check className="size-5" aria-hidden />
                    Save &amp; scan next
                  </>
                )
              ) : (
                <>
                  Next
                  <ArrowRight className="size-5" aria-hidden />
                </>
              )}
            </Button>
          </div>
        </div>
      )}

      {showScanner && (
        <BarcodeScanner
          onDetected={(text) => {
            if (scanTarget === "component") {
              setComponentUpc(text);
            } else if (scanTarget === "location") {
              setShelfLocation(text);
            } else {
              setUpc(text);
            }
            setShowScanner(false);
          }}
          onClose={() => setShowScanner(false)}
        />
      )}
    </AppShell>
  );
}

// ---------------------------------------------------------------------------
// Presentational pieces shared by the scan page's modes. Display only — all
// state and behavior stays in ScanPageInner above.
// ---------------------------------------------------------------------------

// Every success message this page sets starts with one of these words
// ("Saved. Ready for…", "Logged. Ready for…", "Sold — eBay listing…");
// everything else is a validation/error message. Green-vs-amber at a glance
// matters on the scanner, where you're looking at the item, not the screen.
const SUCCESS_MESSAGE = /^(Saved|Logged|Sold)\b/;

function Feedback({ message }: { message: string | null }) {
  if (!message) return null;
  const success = SUCCESS_MESSAGE.test(message);
  return (
    <div
      role="status"
      className={cn(
        "flex items-start gap-2 rounded-xl border px-4 py-3 text-sm font-medium",
        success ? "border-green-200 bg-green-50 text-green-900" : "border-amber-200 bg-amber-50 text-amber-950"
      )}
    >
      {success ? (
        <CircleCheck className="mt-0.5 size-5 shrink-0 text-green-600" aria-hidden />
      ) : (
        <TriangleAlert className="mt-0.5 size-5 shrink-0 text-amber-600" aria-hidden />
      )}
      {message}
    </div>
  );
}

// Moves the cursor into a ScanField once React has rendered the state change
// that cleared it — the field may have lost focus to a tapped button.
function focusScanField(id: string) {
  requestAnimationFrame(() => document.getElementById(id)?.focus());
}

// Shown when a lookup comes back empty: what was tried, and that the field
// is already cleared and waiting — the next trigger pull just works.
function ScanAgainPanel({
  message,
  tried,
  readyText,
  onStartOver,
}: {
  message: string;
  tried: string;
  readyText: string;
  onStartOver?: () => void;
}) {
  return (
    <div role="alert" className="rounded-xl border border-amber-200 bg-amber-50 p-4 text-sm text-amber-950">
      <div className="flex gap-2">
        <SearchX className="mt-0.5 size-5 shrink-0 text-amber-600" aria-hidden />
        <div className="min-w-0">
          <p className="font-semibold">{message}</p>
          <p className="mt-0.5 break-all tabular-nums text-amber-900/80">Scanned: {tried}</p>
        </div>
      </div>
      <p className="mt-3 flex items-center gap-2 rounded-lg bg-surface/80 px-3 py-2.5 font-medium text-primary">
        <ScanBarcode className="size-5 shrink-0 animate-pulse" aria-hidden />
        {readyText}
      </p>
      {onStartOver && (
        <Button variant="outline" size="lg" block onClick={onStartOver} className="mt-3">
          <RotateCcw className="size-5" aria-hidden />
          Start over from the shelf location
        </Button>
      )}
    </div>
  );
}

function BackButton({ onClick, children }: { onClick: () => void; children: ReactNode }) {
  return (
    <Button variant="outline" size="sm" onClick={onClick}>
      <ArrowLeft className="size-4" aria-hidden />
      {children}
    </Button>
  );
}

function CameraButton({ onClick }: { onClick: () => void }) {
  return (
    <Button variant="outline" size="icon-xl" onClick={onClick} className="shrink-0" aria-label="Scan with camera">
      <Camera className="size-5" aria-hidden />
    </Button>
  );
}

// Big tappable choice card — the landing screen's options and the wizard's
// Single item / Bundle choice.
function OptionCard({
  icon: Icon,
  title,
  description,
  onClick,
  href,
  primary = false,
}: {
  icon: LucideIcon;
  title: string;
  description: string;
  onClick?: () => void;
  href?: string;
  primary?: boolean;
}) {
  const className = cn(
    "flex w-full items-center gap-4 rounded-xl border p-4 text-left shadow-sm transition-colors",
    primary
      ? "border-transparent bg-primary text-primary-foreground hover:bg-primary-hover"
      : "border-border bg-surface text-foreground hover:bg-muted active:bg-muted"
  );
  const body = (
    <>
      <span
        className={cn(
          "grid size-12 shrink-0 place-items-center rounded-xl",
          primary ? "bg-white/15" : "bg-blue-50 text-primary"
        )}
      >
        <Icon className="size-6" aria-hidden />
      </span>
      <span className="min-w-0 flex-1">
        <span className="block text-base font-semibold">{title}</span>
        <span className={cn("block text-sm", primary ? "text-white/80" : "text-muted-foreground")}>{description}</span>
      </span>
      <ChevronRight className={cn("size-5 shrink-0", primary ? "text-white/80" : "text-muted-foreground")} aria-hidden />
    </>
  );
  return href ? (
    <Link href={href} className={className}>
      {body}
    </Link>
  ) : (
    <button type="button" onClick={onClick} className={className}>
      {body}
    </button>
  );
}

const RETURN_CONDITION_TEXT: Record<string, string> = {
  new: "new",
  new_other: "open box (new other)",
  used: "used",
  for_parts: "for parts",
};

const MODE_TILE_TONES = {
  danger: "text-red-600 bg-red-50",
  warning: "text-amber-600 bg-amber-50",
  success: "text-green-600 bg-green-50",
} as const;

// Compact entry points into the manifest-only side modes (damaged, dud,
// walk-up) — three across fits a ~360px screen, unlike the old row of
// full-text buttons.
function ModeTile({
  icon: Icon,
  tone,
  label,
  onClick,
}: {
  icon: LucideIcon;
  tone: keyof typeof MODE_TILE_TONES;
  label: string;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="flex flex-col items-center gap-1.5 rounded-lg border border-border bg-surface px-1 py-2.5 text-center text-xs font-medium leading-tight text-foreground transition-colors hover:bg-muted active:bg-muted"
    >
      <span className={cn("grid size-8 place-items-center rounded-lg", MODE_TILE_TONES[tone])}>
        <Icon className="size-4.5" aria-hidden />
      </span>
      {label}
    </button>
  );
}

// Where this product's units were in the sort boxes, so the lister (or a
// helper) can grab them all at once. "Left some here" fixes a box's count
// when not every unit got taken out.
function SortBoxesCard({
  pull,
  onPutBack,
}: {
  pull: { pulled: { boxCode: string; units: number }[]; locations: SortLocation[] };
  onPutBack: (boxCode: string, units: number) => Promise<string | null>;
}) {
  const [openBox, setOpenBox] = useState<string | null>(null);
  const [units, setUnits] = useState("1");
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<string | null>(null);

  if (pull.locations.length === 0) {
    return <p className="text-xs text-muted-foreground">Not sorted into boxes.</p>;
  }
  const total = pull.pulled.reduce((sum, p) => sum + p.units, 0);
  const pulledBefore = pull.locations.reduce((sum, l) => sum + l.pulled, 0);
  const pulledBoxes = pull.locations.filter((l) => l.pulled > 0);

  async function save(boxCode: string) {
    const n = Number(units);
    if (!Number.isInteger(n) || n < 1) return setNote("Enter how many are still in the box.");
    setBusy(true);
    const error = await onPutBack(boxCode, n);
    setBusy(false);
    setNote(error ?? `Put ${n} back in ${boxCode}.`);
    if (!error) setOpenBox(null);
  }

  return (
    <div className="rounded-xl border border-indigo-200 bg-indigo-50 px-3 py-2.5 text-sm text-indigo-950">
      <p className="font-semibold">
        {total > 0
          ? `${total} here: ${pull.pulled.map((p) => `${p.boxCode} x${p.units}`).join(", ")}. Grab them all.`
          : `Already pulled to the table: ${pulledBefore}.`}
      </p>
      {pulledBoxes.length > 0 && (
        <ul className="mt-1.5 flex flex-col gap-1">
          {pulledBoxes.map((l) => (
            <li key={l.boxCode}>
              <div className="flex items-center justify-between gap-2">
                <span className="tabular-nums">
                  {l.boxCode}: {l.pulled} pulled
                  {l.inBox > 0 ? `, ${l.inBox} left in the box` : ""}
                </span>
                <button
                  type="button"
                  className="shrink-0 text-xs font-medium underline"
                  onClick={() => {
                    setOpenBox(openBox === l.boxCode ? null : l.boxCode);
                    setUnits("1");
                    setNote(null);
                  }}
                >
                  Left some here
                </button>
              </div>
              {openBox === l.boxCode && (
                <div className="mt-1.5 flex items-center gap-2">
                  <Input
                    type="number"
                    min={1}
                    max={l.pulled}
                    inputMode="numeric"
                    aria-label={`How many are still in ${l.boxCode}`}
                    className="w-24"
                    value={units}
                    onChange={(e) => setUnits(e.target.value)}
                    onWheel={(e) => e.currentTarget.blur()}
                  />
                  <Button size="sm" variant="outline" onClick={() => save(l.boxCode)} disabled={busy}>
                    {busy ? "Saving…" : "Put back"}
                  </Button>
                </div>
              )}
            </li>
          ))}
        </ul>
      )}
      {note && <p className="mt-1 text-xs">{note}</p>}
    </div>
  );
}

function StepProgress({ current, total }: { current: number; total: number }) {
  return (
    <div>
      <div className="mb-1.5 flex justify-between text-xs font-medium text-muted-foreground">
        <span>
          Step {current + 1} of {total}
        </span>
      </div>
      <div className="flex gap-1" aria-hidden>
        {Array.from({ length: total }, (_, i) => (
          <div key={i} className={cn("h-1.5 flex-1 rounded-full", i <= current ? "bg-primary" : "bg-zinc-200")} />
        ))}
      </div>
    </div>
  );
}

function PhotoTile({ photo, onRemove }: { photo: Photo; onRemove: () => void }) {
  return (
    <div className="relative aspect-square">
      <img src={photo.previewUrl} alt="" className="size-full rounded-lg border border-border object-cover" />
      {photo.status === "uploading" && (
        <div className="absolute inset-0 grid place-items-center rounded-lg bg-zinc-950/45">
          <LoaderCircle className="size-6 animate-spin text-white" aria-label="Uploading" />
        </div>
      )}
      {photo.status === "error" && (
        <div className="absolute inset-0 grid place-items-center rounded-lg bg-red-600/75 text-xs font-medium text-white">
          Failed
        </div>
      )}
      <button
        type="button"
        onClick={onRemove}
        aria-label="Remove photo"
        className="absolute -right-1.5 -top-1.5 grid size-7 place-items-center rounded-full bg-zinc-900 text-white shadow-md"
      >
        <X className="size-4" aria-hidden />
      </button>
    </div>
  );
}

function AddPhotoTile({ onClick }: { onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="flex aspect-square flex-col items-center justify-center gap-1 rounded-lg border-2 border-dashed border-zinc-300 text-xs font-medium text-muted-foreground transition-colors hover:border-primary hover:text-primary active:bg-blue-50"
    >
      <Camera className="size-6" aria-hidden />
      Add photo
    </button>
  );
}

// Number input with a unit suffix inside the field (lb / oz).
function UnitInput({ unit, ...props }: Omit<ComponentProps<"input">, "type" | "size"> & { unit: string }) {
  return (
    <div className="relative">
      <Input size="lg" type="number" placeholder="0" className="pr-12" {...props} />
      <span className="pointer-events-none absolute inset-y-0 right-3 flex items-center text-sm text-muted-foreground">
        {unit}
      </span>
    </div>
  );
}

// Floor / ideal / near-expiry price breakdown shared by walk-up sale and
// shelf sale.
function PriceTiers({
  showFloor,
  floorPrice,
  idealPrice,
  nearExpiryPrice,
  packMultiplier,
}: {
  showFloor: boolean;
  floorPrice: number | null;
  idealPrice: number;
  nearExpiryPrice: number;
  packMultiplier: number;
}) {
  return (
    <div className="mt-4">
      <div className={cn("grid gap-2", showFloor ? "grid-cols-3" : "grid-cols-2")}>
        {showFloor && <PriceTier label="Floor" value={floorPrice != null ? floorPrice * packMultiplier : null} />}
        <PriceTier label="Ideal" value={idealPrice * packMultiplier} highlight />
        <PriceTier label="Near-expiry" value={nearExpiryPrice * packMultiplier} />
      </div>
      {showFloor && floorPrice == null && (
        <p className="mt-2 text-xs text-muted-foreground">
          Enter a landed cost on the manifest to get a floor (minimum acceptable) price.
        </p>
      )}
      {packMultiplier > 1 && (
        <p className="mt-2 text-xs text-muted-foreground">Prices are per pack of {packMultiplier}.</p>
      )}
    </div>
  );
}

function PriceTier({ label, value, highlight = false }: { label: string; value: number | null; highlight?: boolean }) {
  return (
    <div
      className={cn(
        "rounded-lg border px-2 py-2.5 text-center",
        highlight ? "border-blue-200 bg-blue-50" : "border-border bg-background"
      )}
    >
      <p className="text-xs font-medium text-muted-foreground">{label}</p>
      <p className={cn("mt-0.5 text-lg font-semibold tabular-nums", highlight ? "text-primary" : "text-foreground")}>
        {value != null ? `$${value.toFixed(2)}` : "—"}
      </p>
    </div>
  );
}

