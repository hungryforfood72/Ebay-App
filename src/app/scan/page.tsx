"use client";

import BarcodeScanner from "@/components/BarcodeScanner";
import { Alert } from "@/components/ui/Alert";
import { AppShell } from "@/components/ui/AppShell";
import { Badge } from "@/components/ui/Badge";
import { Button, buttonClasses } from "@/components/ui/Button";
import { Card, SectionHeader } from "@/components/ui/Card";
import { cn } from "@/components/ui/cn";
import { CheckboxRow, Field, Input, Select } from "@/components/ui/Input";
import { uploadPhoto } from "@/lib/uploadPhoto";
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
  ScanBarcode,
  Search,
  ShoppingBag,
  Trash2,
  TriangleAlert,
  X,
  type LucideIcon,
} from "lucide-react";
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { Suspense, useEffect, useRef, useState, type ComponentProps, type ReactNode } from "react";

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
              <Field label="Shelf location">
                <Input
                  size="lg"
                  autoFocus
                  type="text"
                  value={shelfSaleLocation}
                  onChange={(e) => setShelfSaleLocation(e.target.value)}
                  onKeyDown={(e) => onScanEnter(e, () => document.getElementById("shelf-sale-upc")?.focus())}
                  placeholder="Scan or type shelf location"
                />
              </Field>
              <Field label="UPC">
                <Input
                  size="lg"
                  id="shelf-sale-upc"
                  type="text"
                  inputMode="numeric"
                  value={shelfSaleUpc}
                  onChange={(e) => setShelfSaleUpc(e.target.value)}
                  onKeyDown={(e) => onScanEnter(e, lookupShelfSaleItem)}
                  placeholder="Scan or type UPC"
                />
              </Field>
              <Button size="xl" block onClick={lookupShelfSaleItem} disabled={shelfSaleLooking}>
                <Search className="size-5" aria-hidden />
                {shelfSaleLooking ? "Looking up…" : "Look up price"}
              </Button>
            </Card>
          )}

          <Feedback message={shelfSaleMessage} />

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
                      Retail ${shelfSaleLookup.retailPrice?.toFixed(2)} · COGS{" "}
                      {shelfSaleLookup.landedCostPerUnit != null
                        ? `$${shelfSaleLookup.landedCostPerUnit.toFixed(2)}`
                        : "— enter a landed cost on the manifest to see this"}
                    </p>
                    <PriceTiers
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

              {shelfSaleLookup.manifestId != null && (
                <CheckboxRow
                  label="Expiring within 6 months"
                  description="Switches the price to the near-expiry tier."
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
              )}

              <SaleFields
                packMultiplier={packMultiplier}
                quantity={shelfSaleQuantity}
                onQuantityChange={setShelfSaleQuantity}
                price={shelfSalePricePerUnit}
                onPriceChange={setShelfSalePricePerUnit}
              />

              <Button variant="success" size="xl" block onClick={saveShelfSale} disabled={shelfSaleSaving}>
                <Check className="size-5" aria-hidden />
                {shelfSaleSaving ? "Saving…" : "Mark as sold"}
              </Button>
              <Button variant="ghost" block onClick={resetShelfSale}>
                Scan a different item instead
              </Button>
            </>
          )}
        </div>
      </AppShell>
    );
  }

  if (activeSessionId === null) {
    return (
      <AppShell width="narrow" title="Scan inventory" subtitle="Start a session, or sell something already on the shelf.">
        <div className="flex flex-col gap-3">
          <OptionCard
            primary
            icon={ScanBarcode}
            title="Start new scan session"
            description="Photograph, scan, and shelve items for listing."
            onClick={() => startSession()}
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

          {sessions === null && <p className="px-1 text-sm text-muted-foreground">Loading sessions…</p>}

          {sessions && sessions.length > 0 && (
            <section className="mt-5">
              <SectionHeader title="Resume a session" description="Pick up where you left off." />
              <div className="flex flex-col gap-2">
                {sessions.map((s) => (
                  <button
                    key={s.id}
                    type="button"
                    onClick={() => startSession(s)}
                    className="flex items-center gap-3 rounded-xl border border-border bg-surface p-4 text-left shadow-sm transition-colors hover:bg-muted active:bg-muted"
                  >
                    <span className="min-w-0 flex-1">
                      <span className="block truncate font-medium text-foreground">
                        {s.label ?? new Date(s.startedAt).toLocaleString()}
                      </span>
                      <span className="text-sm text-muted-foreground">
                        {s._count.items} item{s._count.items === 1 ? "" : "s"} saved
                      </span>
                    </span>
                    <ChevronRight className="size-5 shrink-0 text-muted-foreground" aria-hidden />
                  </button>
                ))}
              </div>
            </section>
          )}
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
          <Field label="UPC">
            <Input
              size="lg"
              autoFocus
              type="text"
              inputMode="numeric"
              value={damagedUpc}
              onChange={(e) => setDamagedUpc(e.target.value)}
              onKeyDown={(e) => onScanEnter(e, saveDamagedEntry)}
              placeholder="Scan or type UPC"
            />
          </Field>
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
          <Field label="UPC">
            <Input
              size="lg"
              autoFocus
              type="text"
              inputMode="numeric"
              value={dudUpc}
              onChange={(e) => setDudUpc(e.target.value)}
              onKeyDown={(e) => onScanEnter(e, saveDudEntry)}
              placeholder="Scan or type UPC"
            />
          </Field>
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
              <Field label="UPC">
                <Input
                  size="lg"
                  autoFocus
                  type="text"
                  inputMode="numeric"
                  value={walkupUpc}
                  onChange={(e) => setWalkupUpc(e.target.value)}
                  onKeyDown={(e) => onScanEnter(e, lookupWalkupUpc)}
                  placeholder="Scan or type UPC"
                />
              </Field>
              <Button size="xl" block onClick={lookupWalkupUpc} disabled={walkupLooking}>
                <Search className="size-5" aria-hidden />
                {walkupLooking ? "Looking up…" : "Look up price"}
              </Button>
            </Card>
          )}

          <Feedback message={walkupMessage} />

          {walkupLookup && (
            <>
              <Card>
                <p className="font-semibold leading-snug text-foreground">{walkupLookup.description}</p>
                <p className="mt-1 text-sm text-muted-foreground">
                  Retail ${walkupLookup.retailPrice.toFixed(2)} · COGS{" "}
                  {walkupLookup.landedCostPerUnit != null
                    ? `$${walkupLookup.landedCostPerUnit.toFixed(2)}`
                    : "— enter a landed cost on the manifest to see this"}
                </p>
                <PriceTiers
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
                  onChange={(e) => {
                    const checked = e.target.checked;
                    setWalkupAlreadyInventoried(checked);
                    const multiplier = walkupPackMultiplier(walkupLookup.alreadyListed, checked);
                    setWalkupPricePerUnit(
                      ((walkupNearExpiry ? walkupLookup.nearExpiryPrice : walkupLookup.idealPrice) * multiplier).toFixed(2)
                    );
                  }}
                />
              )}

              <CheckboxRow
                label="Expiring within 6 months"
                description="Switches the price to the near-expiry tier."
                checked={walkupNearExpiry}
                onChange={(e) => {
                  const checked = e.target.checked;
                  setWalkupNearExpiry(checked);
                  setWalkupPricePerUnit(
                    ((checked ? walkupLookup.nearExpiryPrice : walkupLookup.idealPrice) * packMultiplier).toFixed(2)
                  );
                }}
              />

              <SaleFields
                packMultiplier={packMultiplier}
                quantity={walkupQuantity}
                onQuantityChange={setWalkupQuantity}
                price={walkupPricePerUnit}
                onPriceChange={setWalkupPricePerUnit}
              />

              <Button variant="success" size="xl" block onClick={saveWalkupSale} disabled={walkupSaving}>
                <Check className="size-5" aria-hidden />
                {walkupSaving ? "Saving…" : "Mark as sold"}
              </Button>
              <Button variant="ghost" block onClick={resetWalkupSale}>
                Scan a different item instead
              </Button>
            </>
          )}
        </div>
      </AppShell>
    );
  }

  const isLastStep = stepIndex === steps.length - 1;

  return (
    <AppShell
      focused
      width="narrow"
      title="Scanning"
      subtitle={`${savedThisSession} saved this session`}
      actions={
        <>
          <Link href="/review" className={buttonClasses({ variant: "outline", size: "sm" })}>
            Review
          </Link>
          <Button variant="danger-ghost" size="sm" onClick={finishSession}>
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

        <StepProgress current={stepIndex} total={steps.length} />

        {step === "mode" && (
          <section className="flex flex-col gap-3">
            <p className="text-sm font-medium text-foreground">What are you scanning?</p>
            <OptionCard
              icon={Package}
              title="Single item"
              description="One product, or a multi-pack of the same product."
              onClick={() => {
                setIsBundle(false);
                setStep("photos");
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
            <Field
              label="UPC"
              htmlFor="scan-upc"
              hint="Optional — leave blank for custom/handmade items. Scanning with the handheld scanner auto-advances."
            >
              <div className="flex gap-2">
                <Input
                  id="scan-upc"
                  size="lg"
                  autoFocus
                  type="text"
                  inputMode="numeric"
                  value={upc}
                  onChange={(e) => setUpc(e.target.value)}
                  onKeyDown={(e) => onScanEnter(e, goNext)}
                  placeholder="Scan or type UPC"
                  className="min-w-0"
                />
                <CameraButton
                  onClick={() => {
                    setScanTarget("item");
                    setShowScanner(true);
                  }}
                />
              </div>
            </Field>
          </Card>
        )}

        {step === "quantity" && (
          <Card className="flex flex-col gap-4">
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
            <Field label="Expiration date" hint="Optional — leave blank if it doesn't expire.">
              <Input size="lg" type="date" value={expirationDate} onChange={(e) => setExpirationDate(e.target.value)} />
            </Field>
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
              <Field label="UPC" htmlFor="scan-component-upc">
                <div className="flex gap-2">
                  <Input
                    id="scan-component-upc"
                    size="lg"
                    type="text"
                    inputMode="numeric"
                    value={componentUpc}
                    onChange={(e) => setComponentUpc(e.target.value)}
                    // Scanning a component's UPC adds it to the bundle right
                    // away, so the loop of "photo(s) already taken, scan UPC" is
                    // one trigger-pull per item instead of also tapping Add.
                    onKeyDown={(e) => onScanEnter(e, addBundleComponent)}
                    placeholder="Scan or type UPC"
                    className="min-w-0"
                  />
                  <CameraButton
                    onClick={() => {
                      setScanTarget("component");
                      setShowScanner(true);
                    }}
                  />
                </div>
              </Field>
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
            <Field label="Shelf location" htmlFor="scan-shelf-location" hint="Scanning with the handheld scanner auto-advances.">
              <div className="flex gap-2">
                <Input
                  id="scan-shelf-location"
                  size="lg"
                  autoFocus
                  type="text"
                  list="shelf-location-suggestions"
                  value={shelfLocation}
                  onChange={(e) => setShelfLocation(e.target.value)}
                  onKeyDown={(e) => onScanEnter(e, goNext)}
                  placeholder="Scan or type shelf location"
                  className="min-w-0"
                />
                <CameraButton
                  onClick={() => {
                    setScanTarget("location");
                    setShowScanner(true);
                  }}
                />
              </div>
              <datalist id="shelf-location-suggestions">
                {shelfLocations.map((loc) => (
                  <option key={loc.id} value={loc.label} />
                ))}
              </datalist>
            </Field>
          </Card>
        )}

        {step === "boxWeight" && (
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
            <Button size="xl" block onClick={isLastStep ? saveItem : goNext} disabled={saving}>
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
  floorPrice,
  idealPrice,
  nearExpiryPrice,
  packMultiplier,
}: {
  floorPrice: number | null;
  idealPrice: number;
  nearExpiryPrice: number;
  packMultiplier: number;
}) {
  return (
    <div className="mt-4">
      <div className="grid grid-cols-3 gap-2">
        <PriceTier label="Floor" value={floorPrice != null ? floorPrice * packMultiplier : null} />
        <PriceTier label="Ideal" value={idealPrice * packMultiplier} highlight />
        <PriceTier label="Near-expiry" value={nearExpiryPrice * packMultiplier} />
      </div>
      {floorPrice == null && (
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

// Quantity + price pair shared by walk-up sale and shelf sale — labels
// switch to "packs" when the matched listing is a multipack.
function SaleFields({
  packMultiplier,
  quantity,
  onQuantityChange,
  price,
  onPriceChange,
}: {
  packMultiplier: number;
  quantity: string;
  onQuantityChange: (v: string) => void;
  price: string;
  onPriceChange: (v: string) => void;
}) {
  return (
    <div className="grid grid-cols-2 gap-3">
      <Field label={packMultiplier > 1 ? "Packs sold" : "Quantity sold"}>
        <Input
          size="lg"
          type="number"
          min={1}
          value={quantity}
          onChange={(e) => onQuantityChange(e.target.value)}
          onWheel={(e) => e.currentTarget.blur()}
        />
      </Field>
      <Field label={packMultiplier > 1 ? "Price per pack" : "Price per unit"}>
        <div className="relative">
          <span className="pointer-events-none absolute inset-y-0 left-3 flex items-center text-lg text-muted-foreground">
            $
          </span>
          <Input
            size="lg"
            type="number"
            step="0.01"
            min={0}
            value={price}
            onChange={(e) => onPriceChange(e.target.value)}
            onWheel={(e) => e.currentTarget.blur()}
            className="pl-7"
          />
        </div>
      </Field>
    </div>
  );
}
