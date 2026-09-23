"use client";

import BarcodeScanner from "@/components/BarcodeScanner";
import { UserNavLinks } from "@/components/UserNav";
import { uploadPhoto } from "@/lib/uploadPhoto";
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { Suspense, useEffect, useRef, useState } from "react";

type ScanSession = {
  id: string;
  label: string | null;
  startedAt: string;
  _count: { items: number };
};

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

const SINGLE_STEPS: Step[] = ["mode", "photos", "upc", "quantity", "expiration", "shelfLocation", "boxWeight"];
const BUNDLE_STEPS: Step[] = ["mode", "bundleHeroPhoto", "bundleComponents", "bundleQuantity", "shelfLocation", "boxWeight"];

const ACTIVE_SESSION_KEY = "ebay-tool.activeScanSessionId";
const ACTIVE_MANIFEST_KEY = "ebay-tool.activeManifestId";

function startSinglePhotoUpload(file: File, setPhoto: (p: Photo | null) => void) {
  const id = `${Date.now()}-${Math.random()}`;
  const previewUrl = URL.createObjectURL(file);
  setPhoto({ id, previewUrl, status: "uploading" });
  uploadPhoto(file)
    .then((url) => setPhoto({ id, previewUrl, status: "done", cloudinaryUrl: url }))
    .catch(() => setPhoto({ id, previewUrl, status: "error" }));
}

// Enter fires when a keyboard-wedge scanner finishes typing a scan — advance
// the wizard instead of leaving it as a no-op.
function onScanEnter(e: React.KeyboardEvent<HTMLInputElement>, action: () => void) {
  if (e.key === "Enter") {
    e.preventDefault();
    action();
  }
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
  const [sessions, setSessions] = useState<ScanSession[] | null>(null);
  const [activeSessionId, setActiveSessionId] = useState<string | null>(null);
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
  const [walkupNearExpiry, setWalkupNearExpiry] = useState(false);
  // Defaults to whatever the lookup found (checked when the UPC matches an
  // already-listed Item) — see lookupWalkupUpc. Checked = reduce the live
  // eBay listing and record the sale on that Item directly; unchecked =
  // today's "fresh off the manifest" tally.
  const [walkupAlreadyInventoried, setWalkupAlreadyInventoried] = useState(false);
  const [walkupQuantity, setWalkupQuantity] = useState("1");
  const [walkupPricePerUnit, setWalkupPricePerUnit] = useState("");
  const [walkupSaving, setWalkupSaving] = useState(false);

  // "Sell Shelf Item" — same in-person/cash sale as Walk-up Sale above, but
  // for something that's already on the shelf (already scanned in and
  // listed) rather than mid-sort on a manifest. Found by shelf location +
  // UPC instead of requiring an active manifest session, since there's no
  // way to know which manifest a shelf item came from just by looking at
  // it — see GET /api/items/shelf-lookup. Reachable with no scan session or
  // manifest picked first (rendered before the activeSessionId check
  // below), unlike Walk-up Sale.
  const [shelfSaleMode, setShelfSaleMode] = useState(false);
  const [shelfSaleLocation, setShelfSaleLocation] = useState("");
  const [shelfSaleUpc, setShelfSaleUpc] = useState("");
  const [shelfSaleLooking, setShelfSaleLooking] = useState(false);
  const [shelfSaleMessage, setShelfSaleMessage] = useState<string | null>(null);
  const [shelfSaleLookup, setShelfSaleLookup] = useState<{
    itemId: string;
    manifestId: string | null;
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
  const [shelfSaleNearExpiry, setShelfSaleNearExpiry] = useState(false);
  const [shelfSaleQuantity, setShelfSaleQuantity] = useState("1");
  const [shelfSalePricePerUnit, setShelfSalePricePerUnit] = useState("");
  const [shelfSaleSaving, setShelfSaleSaving] = useState(false);

  const [step, setStep] = useState<Step>("mode");
  const [isBundle, setIsBundle] = useState(false);

  // Single-item mode
  const [photos, setPhotos] = useState<Photo[]>([]);
  const [upc, setUpc] = useState("");
  const [isMultipack, setIsMultipack] = useState(false);
  const [packSize, setPackSize] = useState("");
  const [expirationDate, setExpirationDate] = useState("");

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
  const [boxSizes, setBoxSizes] = useState<LabeledEntry[]>([]);

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
    const stored = localStorage.getItem(ACTIVE_SESSION_KEY);
    const manifestIdFromUrl = searchParams.get("manifestId");

    fetch("/api/sessions")
      .then((r) => r.json())
      .then((data: ScanSession[]) => {
        setSessions(data);
        if (stored && data.some((s) => s.id === stored)) {
          setActiveSessionId(stored);
        } else if (manifestIdFromUrl) {
          // Arrived via "Scan into this manifest" with no session already
          // running — start one immediately instead of making them pick.
          startSession();
        }
      });
    fetch("/api/shelf-locations")
      .then((r) => r.json())
      .then(setShelfLocations);
    fetch("/api/box-sizes")
      .then((r) => r.json())
      .then(setBoxSizes);
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

  async function startSession(existing?: ScanSession) {
    if (existing) {
      setActiveSessionId(existing.id);
      localStorage.setItem(ACTIVE_SESSION_KEY, existing.id);
      return;
    }
    const res = await fetch("/api/sessions", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({}),
    });
    const session: ScanSession = await res.json();
    setSessions((prev) => [session, ...(prev ?? [])]);
    setActiveSessionId(session.id);
    localStorage.setItem(ACTIVE_SESSION_KEY, session.id);
  }

  async function finishSession() {
    if (!activeSessionId) return;
    await fetch(`/api/sessions/${activeSessionId}`, { method: "PATCH" });
    localStorage.removeItem(ACTIVE_SESSION_KEY);
    localStorage.removeItem(ACTIVE_MANIFEST_KEY);
    setActiveSessionId(null);
    setActiveManifestId(null);
    setManifestTitle(null);
    setDamagedMode(false);
    setDudMode(false);
    setWalkupMode(false);
    resetWalkupSale();
    setShelfSaleMode(false);
    resetShelfSale();
    setSavedThisSession(0);
    setSessions((prev) =>
      (prev ?? []).filter((s) => s.id !== activeSessionId)
    );
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
    setWalkupNearExpiry(false);
    setWalkupAlreadyInventoried(false);
    setWalkupQuantity("1");
    setWalkupPricePerUnit("");
    setWalkupMessage(null);
  }

  async function lookupWalkupUpc() {
    if (!activeManifestId) return;
    setWalkupMessage(null);
    if (!walkupUpc.trim()) return setWalkupMessage("Scan or enter a UPC first.");

    setWalkupLooking(true);
    try {
      const res = await fetch(
        `/api/manifests/${activeManifestId}/walkup-sale/lookup?upc=${encodeURIComponent(walkupUpc.trim())}`
      );
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? "Lookup failed.");
      setWalkupLookup(data);
      // Finding a matching active listing strongly implies this IS that
      // case — default checked, but let it be unchecked manually.
      const alreadyInventoried = Boolean(data.alreadyListed);
      setWalkupAlreadyInventoried(alreadyInventoried);
      const multiplier = walkupPackMultiplier(data.alreadyListed, alreadyInventoried);
      setWalkupPricePerUnit((data.idealPrice * multiplier).toFixed(2));
    } catch (e) {
      setWalkupLookup(null);
      setWalkupMessage(e instanceof Error ? e.message : "Something went wrong.");
    } finally {
      setWalkupLooking(false);
    }
  }

  async function saveWalkupSale() {
    if (!activeManifestId || !walkupLookup) return;
    setWalkupMessage(null);
    const qty = Number(walkupQuantity);
    if (!qty || qty < 1) return setWalkupMessage("Enter a quantity of at least 1.");
    const price = Number(walkupPricePerUnit);
    if (!price || price <= 0) return setWalkupMessage("Enter a price per unit.");

    setWalkupSaving(true);
    try {
      const res = await fetch(`/api/manifests/${activeManifestId}/walkup-sale`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          upc: walkupUpc.trim(),
          quantity: qty,
          pricePerUnit: price,
          itemId: walkupAlreadyInventoried ? walkupLookup.alreadyListed?.itemId : undefined,
        }),
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        throw new Error(err.error ?? "Save failed.");
      }
      const wasInventoried = walkupAlreadyInventoried;
      resetWalkupSale();
      setWalkupMessage(
        wasInventoried ? "Sold — eBay listing updated. Ready for the next one." : "Sold! Ready for the next one."
      );
    } catch (e) {
      setWalkupMessage(e instanceof Error ? e.message : "Something went wrong.");
    } finally {
      setWalkupSaving(false);
    }
  }

  function resetShelfSale() {
    setShelfSaleLocation("");
    setShelfSaleUpc("");
    setShelfSaleLookup(null);
    setShelfSaleNearExpiry(false);
    setShelfSaleQuantity("1");
    setShelfSalePricePerUnit("");
    setShelfSaleMessage(null);
  }

  async function lookupShelfSaleItem() {
    setShelfSaleMessage(null);
    if (!shelfSaleLocation.trim()) return setShelfSaleMessage("Scan or enter a shelf location first.");
    if (!shelfSaleUpc.trim()) return setShelfSaleMessage("Scan or enter a UPC first.");

    setShelfSaleLooking(true);
    try {
      const res = await fetch(
        `/api/items/shelf-lookup?shelfLocation=${encodeURIComponent(shelfSaleLocation.trim())}&upc=${encodeURIComponent(shelfSaleUpc.trim())}`
      );
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? "Lookup failed.");
      setShelfSaleLookup(data);
      // Every shelf-sale match is, by definition, already an active
      // listing — unlike Walk-up Sale there's no "fresh off the manifest"
      // branch to choose between.
      const multiplier = walkupPackMultiplier(data.alreadyListed, true);
      const basePrice = data.manifestId != null ? data.idealPrice : (data.currentListedPrice ?? 0);
      setShelfSalePricePerUnit((basePrice * multiplier).toFixed(2));
    } catch (e) {
      setShelfSaleLookup(null);
      setShelfSaleMessage(e instanceof Error ? e.message : "Something went wrong.");
    } finally {
      setShelfSaleLooking(false);
    }
  }

  async function saveShelfSale() {
    if (!shelfSaleLookup) return;
    setShelfSaleMessage(null);
    const qty = Number(shelfSaleQuantity);
    if (!qty || qty < 1) return setShelfSaleMessage("Enter a quantity of at least 1.");
    const price = Number(shelfSalePricePerUnit);
    if (!price || price <= 0) return setShelfSaleMessage("Enter a price per unit.");

    setShelfSaleSaving(true);
    try {
      // A manifest to update means the existing walk-up-sale route (which
      // also keeps that manifest's sold/profit numbers current); no
      // manifest means the lighter item-only route instead — see
      // GET /api/items/shelf-lookup's manifestId: null case.
      const url = shelfSaleLookup.manifestId
        ? `/api/manifests/${shelfSaleLookup.manifestId}/walkup-sale`
        : `/api/items/${shelfSaleLookup.itemId}/shelf-sale`;
      const res = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          upc: shelfSaleUpc.trim(),
          quantity: qty,
          pricePerUnit: price,
          itemId: shelfSaleLookup.itemId,
        }),
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        throw new Error(err.error ?? "Save failed.");
      }
      resetShelfSale();
      setShelfSaleMessage("Sold — eBay listing updated. Scan the next shelf location.");
    } catch (e) {
      setShelfSaleMessage(e instanceof Error ? e.message : "Something went wrong.");
    } finally {
      setShelfSaleSaving(false);
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
    if (fileInputRef.current) fileInputRef.current.value = "";
    if (heroFileInputRef.current) heroFileInputRef.current.value = "";
    if (componentFileInputRef.current) componentFileInputRef.current.value = "";
    // Shelf location, box size, weight, and isBundle are left as-is — items
    // are usually scanned in batches from the same bin into the same box
    // type (and often the same mode), so keeping the selection saves
    // re-entering it for every item. Jump back to the first step that
    // actually needs fresh input for the next item.
    setStep(isBundle ? "bundleHeroPhoto" : "photos");
  }

  const steps = isBundle ? BUNDLE_STEPS : SINGLE_STEPS;
  const stepIndex = steps.indexOf(step);

  function goBack() {
    setMessage(null);
    if (stepIndex > 0) setStep(steps[stepIndex - 1]);
  }

  function goNext() {
    setMessage(null);
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
    if (stepIndex < steps.length - 1) setStep(steps[stepIndex + 1]);
  }

  async function saveItem() {
    setMessage(null);

    if (!shelfLocation.trim()) return setMessage("Shelf location is required.");

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
          shelfLocation: shelfLocation.trim(),
          boxSize: boxSize || null,
          weightLbs: weightLbs ? Number(weightLbs) : null,
          weightOz: weightOz ? Number(weightOz) : null,
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
          scanSessionId: activeSessionId,
          manifestId: activeManifestId,
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
      setMessage("Saved. Ready for the next item.");
      resetForm();
    } catch (e) {
      setMessage(e instanceof Error ? e.message : "Something went wrong.");
    } finally {
      setSaving(false);
    }
  }

  // Selling something already on the shelf — no session or manifest needs
  // to be picked first, so this is checked ahead of the activeSessionId
  // landing screen below rather than nested inside it.
  if (shelfSaleMode) {
    const packMultiplier = shelfSaleLookup ? walkupPackMultiplier(shelfSaleLookup.alreadyListed, true) : 1;
    return (
      <main className="mx-auto flex min-h-dvh max-w-md flex-col gap-4 p-4">
        <div className="flex items-center justify-between">
          <h1 className="text-lg font-semibold">Sell Shelf Item</h1>
          <button
            type="button"
            onClick={() => {
              setShelfSaleMode(false);
              resetShelfSale();
            }}
            className="text-sm underline"
          >
            Back
          </button>
        </div>
        <p className="text-xs text-gray-400">
          For something already on the shelf — scan its shelf location, then its UPC. In-person cash sale, no eBay
          fees, no shipping.
        </p>

        {!shelfSaleLookup && (
          <>
            <section className="flex flex-col gap-1">
              <label className="text-sm font-medium">Shelf location</label>
              <input
                autoFocus
                type="text"
                value={shelfSaleLocation}
                onChange={(e) => setShelfSaleLocation(e.target.value)}
                onKeyDown={(e) => onScanEnter(e, () => document.getElementById("shelf-sale-upc")?.focus())}
                placeholder="Scan or type shelf location"
                className="rounded border px-3 py-2"
              />
            </section>
            <section className="flex flex-col gap-1">
              <label className="text-sm font-medium">UPC</label>
              <input
                id="shelf-sale-upc"
                type="text"
                inputMode="numeric"
                value={shelfSaleUpc}
                onChange={(e) => setShelfSaleUpc(e.target.value)}
                onKeyDown={(e) => onScanEnter(e, lookupShelfSaleItem)}
                placeholder="Scan or type UPC"
                className="rounded border px-3 py-2"
              />
              <button
                type="button"
                onClick={lookupShelfSaleItem}
                disabled={shelfSaleLooking}
                className="mt-2 rounded bg-black py-3 text-center text-white disabled:opacity-50"
              >
                {shelfSaleLooking ? "Looking up…" : "Look up price"}
              </button>
            </section>
          </>
        )}

        {shelfSaleMessage && <p className="text-sm">{shelfSaleMessage}</p>}

        {shelfSaleLookup && (
          <>
            {shelfSaleLookup.isBundle && (
              <p className="rounded border border-amber-300 bg-amber-50 p-2 text-sm font-medium text-amber-900">
                {shelfSaleLookup.note ?? "This UPC is part of a bundle — it has to be sold as the whole bundle."}
              </p>
            )}
            <section className="rounded border p-3">
              <p className="font-medium">{shelfSaleLookup.description}</p>
              {shelfSaleLookup.isBundle ? (
                <p className="mt-1 text-xs text-gray-400">
                  Bundle pricing is the listing&apos;s own current price, not a single manifest line.
                  {shelfSaleLookup.currentListedPrice != null && (
                    <> Currently listed at ${shelfSaleLookup.currentListedPrice.toFixed(2)}.</>
                  )}
                </p>
              ) : shelfSaleLookup.manifestId != null ? (
                <>
                  <p className="text-xs text-gray-400">
                    Retail price: ${shelfSaleLookup.retailPrice?.toFixed(2)} · COGS:{" "}
                    {shelfSaleLookup.landedCostPerUnit != null
                      ? `$${shelfSaleLookup.landedCostPerUnit.toFixed(2)}`
                      : "enter a landed cost on the manifest to see this"}
                  </p>
                  <div className="mt-2 flex flex-col gap-1 text-sm">
                    <p>
                      Floor (min acceptable):{" "}
                      {shelfSaleLookup.floorPrice != null ? (
                        <strong>${(shelfSaleLookup.floorPrice * packMultiplier).toFixed(2)}</strong>
                      ) : (
                        <span className="text-xs text-gray-400">
                          Enter a landed cost on the manifest to get a floor price
                        </span>
                      )}
                    </p>
                    <p>
                      Ideal: <strong>${((shelfSaleLookup.idealPrice ?? 0) * packMultiplier).toFixed(2)}</strong>
                    </p>
                    <p>
                      Near-expiry:{" "}
                      <strong>${((shelfSaleLookup.nearExpiryPrice ?? 0) * packMultiplier).toFixed(2)}</strong>
                    </p>
                    {packMultiplier > 1 && (
                      <p className="text-xs text-gray-400">Prices above are per pack of {packMultiplier}.</p>
                    )}
                  </div>
                </>
              ) : (
                <p className="mt-1 text-xs text-gray-400">
                  This item wasn&apos;t scanned under a manifest, so there&apos;s no floor/ideal pricing breakdown or
                  manifest profit tracking for it — its current eBay listing price is shown below as a reference;
                  enter whatever you actually charged.
                  {shelfSaleLookup.currentListedPrice != null && (
                    <> Currently listed at ${shelfSaleLookup.currentListedPrice.toFixed(2)}.</>
                  )}
                </p>
              )}
            </section>

            <p className="rounded border border-blue-200 bg-blue-50 p-2 text-sm">
              {shelfSaleLookup.alreadyListed.isMultipack && shelfSaleLookup.alreadyListed.packSize
                ? `${shelfSaleLookup.alreadyListed.availableQuantity} pack(s) of ${shelfSaleLookup.alreadyListed.packSize} available on eBay (${
                    shelfSaleLookup.alreadyListed.availableQuantity * shelfSaleLookup.alreadyListed.packSize
                  } units total)`
                : `${shelfSaleLookup.alreadyListed.availableQuantity} available on eBay`}
              . Selling this reduces that listing.
            </p>

            {shelfSaleLookup.manifestId != null && (
              <label className="flex items-center gap-2 text-sm">
                <input
                  type="checkbox"
                  checked={shelfSaleNearExpiry}
                  onChange={(e) => {
                    const checked = e.target.checked;
                    setShelfSaleNearExpiry(checked);
                    setShelfSalePricePerUnit(
                      (
                        (checked ? (shelfSaleLookup.nearExpiryPrice ?? 0) : (shelfSaleLookup.idealPrice ?? 0)) *
                        packMultiplier
                      ).toFixed(2)
                    );
                  }}
                />
                Expiring within 6 months
              </label>
            )}

            <section>
              <label className="text-sm font-medium">{packMultiplier > 1 ? "Packs sold" : "Quantity sold"}</label>
              <input
                type="number"
                min={1}
                value={shelfSaleQuantity}
                onChange={(e) => setShelfSaleQuantity(e.target.value)}
                onWheel={(e) => e.currentTarget.blur()}
                className="w-full rounded border px-3 py-2"
              />
            </section>

            <section>
              <label className="text-sm font-medium">{packMultiplier > 1 ? "Price per pack" : "Price per unit"}</label>
              <input
                type="number"
                step="0.01"
                min={0}
                value={shelfSalePricePerUnit}
                onChange={(e) => setShelfSalePricePerUnit(e.target.value)}
                onWheel={(e) => e.currentTarget.blur()}
                className="w-full rounded border px-3 py-2"
              />
            </section>

            <button
              type="button"
              onClick={saveShelfSale}
              disabled={shelfSaleSaving}
              className="rounded bg-green-600 py-4 text-center text-white disabled:opacity-50"
            >
              {shelfSaleSaving ? "Saving…" : "Mark as sold"}
            </button>
            <button type="button" onClick={resetShelfSale} className="text-sm text-gray-500 underline">
              Scan a different item instead
            </button>
          </>
        )}
      </main>
    );
  }

  if (activeSessionId === null) {
    return (
      <main className="mx-auto flex min-h-dvh max-w-md flex-col gap-4 p-6">
        <h1 className="text-xl font-semibold">Scan Inventory</h1>

        <button
          type="button"
          onClick={() => startSession()}
          className="rounded-lg bg-black px-4 py-3 text-white"
        >
          Start new scan session
        </button>

        <Link
          href="/manifests"
          className="rounded-lg border-2 border-black px-4 py-3 text-center font-medium"
        >
          Scan with Manifest
        </Link>

        <button
          type="button"
          onClick={() => setShelfSaleMode(true)}
          className="rounded-lg border-2 border-green-600 px-4 py-3 text-center font-medium text-green-700"
        >
          Sell Shelf Item
        </button>

        {sessions === null && <p className="text-sm text-gray-500">Loading…</p>}

        {sessions && sessions.length > 0 && (
          <div className="flex flex-col gap-2">
            <p className="text-sm text-gray-500">Or resume a session in progress:</p>
            {sessions.map((s) => (
              <button
                key={s.id}
                type="button"
                onClick={() => startSession(s)}
                className="rounded-lg border px-4 py-3 text-left"
              >
                {s.label ?? new Date(s.startedAt).toLocaleString()} —{" "}
                {s._count.items} item{s._count.items === 1 ? "" : "s"} saved
              </button>
            ))}
          </div>
        )}

        <a href="/review" className="mt-4 text-center text-sm underline">
          Go to review queue instead
        </a>
        <Link href="/" className="text-center text-sm underline">
          Dashboard
        </Link>
      </main>
    );
  }

  // Sorting-only path — no photos, no listing, just a tally of bad units
  // against the manifest. Separate from the normal item wizard entirely.
  if (damagedMode) {
    return (
      <main className="mx-auto flex min-h-dvh max-w-md flex-col gap-4 p-4">
        <div className="flex items-center justify-between">
          <h1 className="text-lg font-semibold">Scan as Damaged/Expired</h1>
          <button type="button" onClick={() => setDamagedMode(false)} className="text-sm underline">
            Back to scanning
          </button>
        </div>
        {manifestTitle && <p className="text-xs text-gray-400">Manifest: {manifestTitle}</p>}

        <section className="flex flex-col gap-1">
          <label className="text-sm font-medium">UPC</label>
          <input
            autoFocus
            type="text"
            inputMode="numeric"
            value={damagedUpc}
            onChange={(e) => setDamagedUpc(e.target.value)}
            onKeyDown={(e) => onScanEnter(e, saveDamagedEntry)}
            placeholder="Scan or type UPC"
            className="rounded border px-3 py-2"
          />
        </section>

        <section>
          <label className="text-sm font-medium">Quantity bad</label>
          <input
            type="number"
            min={1}
            value={damagedQuantity}
            onChange={(e) => setDamagedQuantity(e.target.value)}
            onWheel={(e) => e.currentTarget.blur()}
            className="w-full rounded border px-3 py-2"
          />
        </section>

        {damagedMessage && <p className="text-sm">{damagedMessage}</p>}

        <button
          type="button"
          onClick={saveDamagedEntry}
          disabled={damagedSaving}
          className="rounded bg-red-600 py-4 text-center text-white disabled:opacity-50"
        >
          {damagedSaving ? "Logging…" : "Log damaged/expired"}
        </button>
      </main>
    );
  }

  // Same sorting-only path as damagedMode above — physically arrived fine,
  // just never getting listed (dead event merch, no resale value, etc.).
  // Still counts as "accounted for" on the manifest, just not "received"
  // in the sense of ever going through review/eBay.
  if (dudMode) {
    return (
      <main className="mx-auto flex min-h-dvh max-w-md flex-col gap-4 p-4">
        <div className="flex items-center justify-between">
          <h1 className="text-lg font-semibold">Scan as Dud/Unsellable</h1>
          <button type="button" onClick={() => setDudMode(false)} className="text-sm underline">
            Back to scanning
          </button>
        </div>
        {manifestTitle && <p className="text-xs text-gray-400">Manifest: {manifestTitle}</p>}
        <p className="text-xs text-gray-400">
          For stuff that arrived fine but you&apos;re not listing — dead event merch, no resale value, etc.
          Not damaged/expired.
        </p>

        <section className="flex flex-col gap-1">
          <label className="text-sm font-medium">UPC</label>
          <input
            autoFocus
            type="text"
            inputMode="numeric"
            value={dudUpc}
            onChange={(e) => setDudUpc(e.target.value)}
            onKeyDown={(e) => onScanEnter(e, saveDudEntry)}
            placeholder="Scan or type UPC"
            className="rounded border px-3 py-2"
          />
        </section>

        <section>
          <label className="text-sm font-medium">Quantity not sellable</label>
          <input
            type="number"
            min={1}
            value={dudQuantity}
            onChange={(e) => setDudQuantity(e.target.value)}
            onWheel={(e) => e.currentTarget.blur()}
            className="w-full rounded border px-3 py-2"
          />
        </section>

        {dudMessage && <p className="text-sm">{dudMessage}</p>}

        <button
          type="button"
          onClick={saveDudEntry}
          disabled={dudSaving}
          className="rounded bg-orange-600 py-4 text-center text-white disabled:opacity-50"
        >
          {dudSaving ? "Logging…" : "Log dud/unsellable"}
        </button>
      </main>
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
      <main className="mx-auto flex min-h-dvh max-w-md flex-col gap-4 p-4">
        <div className="flex items-center justify-between">
          <h1 className="text-lg font-semibold">Walk-up Sale</h1>
          <button
            type="button"
            onClick={() => {
              setWalkupMode(false);
              resetWalkupSale();
            }}
            className="text-sm underline"
          >
            Back to scanning
          </button>
        </div>
        {manifestTitle && <p className="text-xs text-gray-400">Manifest: {manifestTitle}</p>}
        <p className="text-xs text-gray-400">In-person cash sale, right now — no eBay fees, no shipping.</p>

        {!walkupLookup && (
          <section className="flex flex-col gap-1">
            <label className="text-sm font-medium">UPC</label>
            <input
              autoFocus
              type="text"
              inputMode="numeric"
              value={walkupUpc}
              onChange={(e) => setWalkupUpc(e.target.value)}
              onKeyDown={(e) => onScanEnter(e, lookupWalkupUpc)}
              placeholder="Scan or type UPC"
              className="rounded border px-3 py-2"
            />
            <button
              type="button"
              onClick={lookupWalkupUpc}
              disabled={walkupLooking}
              className="mt-2 rounded bg-black py-3 text-center text-white disabled:opacity-50"
            >
              {walkupLooking ? "Looking up…" : "Look up price"}
            </button>
          </section>
        )}

        {walkupMessage && <p className="text-sm">{walkupMessage}</p>}

        {walkupLookup && (
          <>
            <section className="rounded border p-3">
              <p className="font-medium">{walkupLookup.description}</p>
              <p className="text-xs text-gray-400">
                Retail price: ${walkupLookup.retailPrice.toFixed(2)} · COGS:{" "}
                {walkupLookup.landedCostPerUnit != null
                  ? `$${walkupLookup.landedCostPerUnit.toFixed(2)}`
                  : "enter a landed cost on the manifest to see this"}
              </p>
              <div className="mt-2 flex flex-col gap-1 text-sm">
                <p>
                  Floor (min acceptable):{" "}
                  {walkupLookup.floorPrice != null ? (
                    <strong>${(walkupLookup.floorPrice * packMultiplier).toFixed(2)}</strong>
                  ) : (
                    <span className="text-xs text-gray-400">
                      Enter a landed cost on the manifest to get a floor price
                    </span>
                  )}
                </p>
                <p>
                  Ideal: <strong>${(walkupLookup.idealPrice * packMultiplier).toFixed(2)}</strong>
                </p>
                <p>
                  Near-expiry: <strong>${(walkupLookup.nearExpiryPrice * packMultiplier).toFixed(2)}</strong>
                </p>
                {packMultiplier > 1 && (
                  <p className="text-xs text-gray-400">Prices above are per pack of {packMultiplier}.</p>
                )}
              </div>
            </section>

            {walkupLookup.alreadyListed && (
              <label className="flex items-center gap-2 rounded border border-blue-200 bg-blue-50 p-2 text-sm">
                <input
                  type="checkbox"
                  checked={walkupAlreadyInventoried}
                  onChange={(e) => {
                    const checked = e.target.checked;
                    setWalkupAlreadyInventoried(checked);
                    const multiplier = walkupPackMultiplier(walkupLookup.alreadyListed, checked);
                    setWalkupPricePerUnit(
                      ((walkupNearExpiry ? walkupLookup.nearExpiryPrice : walkupLookup.idealPrice) * multiplier).toFixed(
                        2
                      )
                    );
                  }}
                />
                Already inventoried —{" "}
                {walkupLookup.alreadyListed.isMultipack && walkupLookup.alreadyListed.packSize
                  ? `${walkupLookup.alreadyListed.availableQuantity} pack(s) of ${walkupLookup.alreadyListed.packSize} available on eBay (${
                      walkupLookup.alreadyListed.availableQuantity * walkupLookup.alreadyListed.packSize
                    } units total)`
                  : `${walkupLookup.alreadyListed.availableQuantity} available on eBay`}
                . Reduce that listing instead of logging a fresh receive.
              </label>
            )}

            <label className="flex items-center gap-2 text-sm">
              <input
                type="checkbox"
                checked={walkupNearExpiry}
                onChange={(e) => {
                  const checked = e.target.checked;
                  setWalkupNearExpiry(checked);
                  setWalkupPricePerUnit(
                    ((checked ? walkupLookup.nearExpiryPrice : walkupLookup.idealPrice) * packMultiplier).toFixed(2)
                  );
                }}
              />
              Expiring within 6 months
            </label>

            <section>
              <label className="text-sm font-medium">{packMultiplier > 1 ? "Packs sold" : "Quantity sold"}</label>
              <input
                type="number"
                min={1}
                value={walkupQuantity}
                onChange={(e) => setWalkupQuantity(e.target.value)}
                onWheel={(e) => e.currentTarget.blur()}
                className="w-full rounded border px-3 py-2"
              />
            </section>

            <section>
              <label className="text-sm font-medium">{packMultiplier > 1 ? "Price per pack" : "Price per unit"}</label>
              <input
                type="number"
                step="0.01"
                min={0}
                value={walkupPricePerUnit}
                onChange={(e) => setWalkupPricePerUnit(e.target.value)}
                onWheel={(e) => e.currentTarget.blur()}
                className="w-full rounded border px-3 py-2"
              />
            </section>

            <button
              type="button"
              onClick={saveWalkupSale}
              disabled={walkupSaving}
              className="rounded bg-green-600 py-4 text-center text-white disabled:opacity-50"
            >
              {walkupSaving ? "Saving…" : "Mark as sold"}
            </button>
            <button type="button" onClick={resetWalkupSale} className="text-sm text-gray-500 underline">
              Scan a different item instead
            </button>
          </>
        )}
      </main>
    );
  }

  const isLastStep = stepIndex === steps.length - 1;

  return (
    <main className="mx-auto flex min-h-dvh max-w-md flex-col gap-4 p-4 pb-24">
      <div className="flex items-center justify-between">
        <h1 className="text-lg font-semibold">
          Scanning · {savedThisSession} saved
        </h1>
        <div className="flex items-center gap-3">
          <a href="/review" className="text-sm underline">
            Review
          </a>
          <button
            type="button"
            onClick={finishSession}
            className="text-sm text-red-600 underline"
          >
            Finish session
          </button>
          <UserNavLinks />
        </div>
      </div>

      {activeManifestId && (
        <div className="flex items-center justify-between rounded border bg-gray-50 px-3 py-2 text-xs">
          <span>
            Manifest: {manifestTitle ?? "…"}{" "}
            <Link href={`/manifests/${activeManifestId}`} className="underline">
              dashboard
            </Link>
          </span>
          <div className="flex gap-2">
            <button
              type="button"
              onClick={() => setDamagedMode(true)}
              className="rounded bg-red-600 px-2 py-1 text-white"
            >
              Scan as Damaged/Expired
            </button>
            <button
              type="button"
              onClick={() => setDudMode(true)}
              className="rounded bg-orange-600 px-2 py-1 text-white"
            >
              Scan as Dud/Unsellable
            </button>
            <button
              type="button"
              onClick={() => setWalkupMode(true)}
              className="rounded bg-green-600 px-2 py-1 text-white"
            >
              Walk-up Sale
            </button>
          </div>
        </div>
      )}

      <p className="text-xs text-gray-400">
        Step {stepIndex + 1} of {steps.length}
      </p>

      {step === "mode" && (
        <section className="flex flex-col gap-3">
          <label className="text-sm font-medium">What are you scanning?</label>
          <div className="flex flex-col gap-3">
            <button
              type="button"
              onClick={() => {
                setIsBundle(false);
                setStep("photos");
              }}
              className="rounded-lg border-2 border-black px-4 py-6 text-center text-lg font-medium"
            >
              Single item
            </button>
            <button
              type="button"
              onClick={() => {
                setIsBundle(true);
                setStep("bundleHeroPhoto");
              }}
              className="rounded-lg border-2 border-black px-4 py-6 text-center text-lg font-medium"
            >
              Bundle
            </button>
          </div>
        </section>
      )}

      {step === "photos" && (
        <section className="flex flex-col gap-2">
          <label className="text-sm font-medium">Photos</label>
          <div className="flex flex-wrap gap-2">
            {photos.map((p) => (
              <div key={p.id} className="relative h-20 w-20">
                <img
                  src={p.previewUrl}
                  alt=""
                  className="h-full w-full rounded object-cover"
                />
                {p.status === "uploading" && (
                  <div className="absolute inset-0 flex items-center justify-center rounded bg-black/40 text-xs text-white">
                    ...
                  </div>
                )}
                {p.status === "error" && (
                  <div className="absolute inset-0 flex items-center justify-center rounded bg-red-600/70 text-xs text-white">
                    Failed
                  </div>
                )}
                <button
                  type="button"
                  onClick={() => removePhoto(p.id)}
                  className="absolute -right-1 -top-1 flex h-5 w-5 items-center justify-center rounded-full bg-black text-xs text-white"
                >
                  ×
                </button>
              </div>
            ))}
            <button
              type="button"
              onClick={() => fileInputRef.current?.click()}
              className="flex h-20 w-20 items-center justify-center rounded border border-dashed text-sm text-gray-500"
            >
              + Photo
            </button>
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
        </section>
      )}

      {step === "upc" && (
        <section className="flex flex-col gap-1">
          <label className="text-sm font-medium">UPC (optional — leave blank for custom/handmade items)</label>
          <div className="flex gap-2">
            <input
              autoFocus
              type="text"
              inputMode="numeric"
              value={upc}
              onChange={(e) => setUpc(e.target.value)}
              onKeyDown={(e) => onScanEnter(e, goNext)}
              placeholder="Scan or type UPC, or leave blank"
              className="flex-1 rounded border px-3 py-2"
            />
            <button
              type="button"
              onClick={() => {
                setScanTarget("item");
                setShowScanner(true);
              }}
              className="rounded bg-black px-3 py-2 text-sm text-white"
            >
              Camera
            </button>
          </div>
          <p className="text-xs text-gray-400">Scanning with the handheld scanner auto-advances.</p>
        </section>
      )}

      {step === "quantity" && (
        <section className="flex flex-col gap-3">
          <label className="flex items-center gap-2 text-sm font-medium">
            <input
              type="checkbox"
              checked={isMultipack}
              onChange={(e) => setIsMultipack(e.target.checked)}
            />
            Multi-pack
          </label>

          {isMultipack && (
            <div>
              <label className="text-sm font-medium">Pack size</label>
              <input
                type="number"
                min={2}
                value={packSize}
                onChange={(e) => setPackSize(e.target.value)}
                onWheel={(e) => e.currentTarget.blur()}
                placeholder="e.g. 3"
                className="w-full rounded border px-3 py-2"
              />
            </div>
          )}

          <div>
            <label className="text-sm font-medium">Quantity</label>
            <input
              type="number"
              min={1}
              value={quantity}
              onChange={(e) => setQuantity(e.target.value)}
              onWheel={(e) => e.currentTarget.blur()}
              className="w-full rounded border px-3 py-2"
            />
          </div>
        </section>
      )}

      {step === "expiration" && (
        <section>
          <label className="text-sm font-medium">
            Expiration date <span className="text-gray-400">(optional)</span>
          </label>
          <input
            type="date"
            value={expirationDate}
            onChange={(e) => setExpirationDate(e.target.value)}
            className="w-full rounded border px-3 py-2"
          />
        </section>
      )}

      {step === "bundleHeroPhoto" && (
        <section className="flex flex-col gap-2">
          <label className="text-sm font-medium">
            Bundle photo <span className="text-gray-400">(everything together — the main listing photo)</span>
          </label>
          <div className="flex flex-wrap gap-2">
            {heroPhoto && (
              <div className="relative h-20 w-20">
                <img
                  src={heroPhoto.previewUrl}
                  alt=""
                  className="h-full w-full rounded object-cover"
                />
                {heroPhoto.status === "uploading" && (
                  <div className="absolute inset-0 flex items-center justify-center rounded bg-black/40 text-xs text-white">
                    ...
                  </div>
                )}
                {heroPhoto.status === "error" && (
                  <div className="absolute inset-0 flex items-center justify-center rounded bg-red-600/70 text-xs text-white">
                    Failed
                  </div>
                )}
                <button
                  type="button"
                  onClick={() => setHeroPhoto(null)}
                  className="absolute -right-1 -top-1 flex h-5 w-5 items-center justify-center rounded-full bg-black text-xs text-white"
                >
                  ×
                </button>
              </div>
            )}
            {!heroPhoto && (
              <button
                type="button"
                onClick={() => heroFileInputRef.current?.click()}
                className="flex h-20 w-20 items-center justify-center rounded border border-dashed text-sm text-gray-500"
              >
                + Photo
              </button>
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
        </section>
      )}

      {step === "bundleComponents" && (
        <>
          <section className="flex flex-col gap-2 rounded-lg border p-3">
            <label className="text-sm font-medium">Add an item to this bundle</label>

            <div className="flex flex-wrap items-center gap-2">
              {componentPhotos.map((p) => (
                <div key={p.id} className="relative h-14 w-14">
                  <img
                    src={p.previewUrl}
                    alt=""
                    className="h-full w-full rounded object-cover"
                  />
                  {p.status === "uploading" && (
                    <div className="absolute inset-0 flex items-center justify-center rounded bg-black/40 text-xs text-white">
                      ...
                    </div>
                  )}
                  <button
                    type="button"
                    onClick={() => removeComponentPhoto(p.id)}
                    className="absolute -right-1 -top-1 flex h-4 w-4 items-center justify-center rounded-full bg-black text-[10px] text-white"
                  >
                    ×
                  </button>
                </div>
              ))}
              <button
                type="button"
                onClick={() => componentFileInputRef.current?.click()}
                className="flex h-14 w-14 items-center justify-center rounded border border-dashed text-xs text-gray-500"
              >
                + Photo
              </button>
              <input
                ref={componentFileInputRef}
                type="file"
                accept="image/*"
                capture="environment"
                multiple
                className="hidden"
                onChange={(e) => handleComponentFiles(e.target.files)}
              />

              <input
                type="text"
                inputMode="numeric"
                value={componentUpc}
                onChange={(e) => setComponentUpc(e.target.value)}
                // Scanning a component's UPC adds it to the bundle right
                // away, so the loop of "photo(s) already taken, scan UPC" is
                // one trigger-pull per item instead of also tapping Add.
                onKeyDown={(e) => onScanEnter(e, addBundleComponent)}
                placeholder="UPC"
                className="min-w-0 flex-1 rounded border px-3 py-2 text-sm"
              />
              <button
                type="button"
                onClick={() => {
                  setScanTarget("component");
                  setShowScanner(true);
                }}
                className="rounded bg-black px-3 py-2 text-sm text-white"
              >
                Camera
              </button>
              <input
                type="number"
                min={1}
                value={componentQuantity}
                onChange={(e) => setComponentQuantity(e.target.value)}
                onWheel={(e) => e.currentTarget.blur()}
                placeholder="Qty"
                className="w-16 rounded border px-2 py-2 text-sm"
              />
            </div>

            <div>
              <label className="text-xs text-gray-500">
                Expiration date <span className="text-gray-400">(optional, this item only)</span>
              </label>
              <input
                type="date"
                value={componentExpirationDate}
                onChange={(e) => setComponentExpirationDate(e.target.value)}
                className="w-full rounded border px-3 py-2 text-sm"
              />
            </div>

            <button
              type="button"
              onClick={addBundleComponent}
              disabled={!componentUpc.trim() || componentPhotos.some((p) => p.status === "uploading")}
              className="rounded bg-black px-3 py-2 text-sm text-white disabled:opacity-40"
            >
              Add to bundle
            </button>
          </section>

          {bundleComponents.length > 0 && (
            <section className="flex flex-col gap-2">
              <label className="text-sm font-medium">
                Items in this bundle ({bundleComponents.length})
              </label>
              <ul className="flex flex-col gap-2">
                {bundleComponents.map((c) => (
                  <li
                    key={c.id}
                    className="flex items-center gap-3 rounded border p-2 text-sm"
                  >
                    {c.photos.length > 0 && (
                      <div className="flex -space-x-2">
                        {c.photos.map((p) => (
                          <img
                            key={p.id}
                            src={p.previewUrl}
                            alt=""
                            className="h-10 w-10 rounded-full border-2 border-white object-cover"
                          />
                        ))}
                      </div>
                    )}
                    <span className="flex-1">
                      UPC {c.upc} — qty {c.quantity}
                      {c.expirationDate && ` — exp ${c.expirationDate}`}
                    </span>
                    <button
                      type="button"
                      onClick={() => removeBundleComponent(c.id)}
                      className="text-xs text-red-600"
                    >
                      Remove
                    </button>
                  </li>
                ))}
              </ul>
            </section>
          )}
        </>
      )}

      {step === "bundleQuantity" && (
        <section>
          <label className="text-sm font-medium">How many of this bundle do you have?</label>
          <input
            type="number"
            min={1}
            value={quantity}
            onChange={(e) => setQuantity(e.target.value)}
            onWheel={(e) => e.currentTarget.blur()}
            className="w-full rounded border px-3 py-2"
          />
        </section>
      )}

      {step === "shelfLocation" && (
        <section className="flex flex-col gap-1">
          <label className="text-sm font-medium">Shelf location</label>
          <div className="flex gap-2">
            <input
              autoFocus
              type="text"
              list="shelf-location-suggestions"
              value={shelfLocation}
              onChange={(e) => setShelfLocation(e.target.value)}
              onKeyDown={(e) => onScanEnter(e, goNext)}
              placeholder="Scan or type shelf location"
              className="flex-1 rounded border px-3 py-2"
            />
            <datalist id="shelf-location-suggestions">
              {shelfLocations.map((loc) => (
                <option key={loc.id} value={loc.label} />
              ))}
            </datalist>
            <button
              type="button"
              onClick={() => {
                setScanTarget("location");
                setShowScanner(true);
              }}
              className="rounded bg-black px-3 py-2 text-sm text-white"
            >
              Camera
            </button>
          </div>
          <p className="text-xs text-gray-400">Scanning with the handheld scanner auto-advances.</p>
        </section>
      )}

      {step === "boxWeight" && (
        <>
          <section>
            <label className="text-sm font-medium">
              Box size {isBundle && <span className="text-gray-400">(for the whole bundle)</span>}
            </label>
            <select
              value={boxSize}
              onChange={(e) => setBoxSize(e.target.value)}
              className="w-full rounded border px-3 py-2"
            >
              <option value="">Select box size…</option>
              {boxSizes.map((b) => (
                <option key={b.id} value={b.label}>
                  {b.label}
                </option>
              ))}
            </select>
            {boxSizes.length === 0 && (
              <a href="/settings" className="mt-1 inline-block text-xs text-blue-600 underline">
                Add box sizes in Settings
              </a>
            )}
          </section>

          <section>
            <label className="text-sm font-medium">
              Weight {isBundle && <span className="text-gray-400">(for the whole bundle)</span>}
            </label>
            <div className="flex items-center gap-2">
              <input
                type="number"
                min={0}
                placeholder="lb"
                value={weightLbs}
                onChange={(e) => setWeightLbs(e.target.value)}
                onWheel={(e) => e.currentTarget.blur()}
                className="w-20 rounded border px-3 py-2"
              />
              <span className="text-sm text-gray-400">lb</span>
              <input
                type="number"
                min={0}
                max={15}
                placeholder="oz"
                value={weightOz}
                onChange={(e) => setWeightOz(e.target.value)}
                onWheel={(e) => e.currentTarget.blur()}
                className="w-20 rounded border px-3 py-2"
              />
              <span className="text-sm text-gray-400">oz</span>
            </div>
          </section>
        </>
      )}

      {message && <p className="text-sm">{message}</p>}

      {/* The mode step's two big buttons ARE its navigation — no generic
          Next button needed (or wanted) there. */}
      {step !== "mode" && (
        <div className="fixed inset-x-0 bottom-0 mx-auto flex max-w-md gap-px overflow-hidden rounded-t-lg">
          {stepIndex > 0 && (
            <button
              type="button"
              onClick={goBack}
              className="w-24 bg-gray-700 py-4 text-center text-white"
            >
              Back
            </button>
          )}
          <button
            type="button"
            onClick={isLastStep ? saveItem : goNext}
            disabled={saving}
            className="flex-1 bg-black py-4 text-center text-white disabled:opacity-50"
          >
            {isLastStep ? (saving ? "Saving…" : "Save & scan next") : "Next"}
          </button>
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
    </main>
  );
}
