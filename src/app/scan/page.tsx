"use client";

import BarcodeScanner from "@/components/BarcodeScanner";
import { uploadPhoto } from "@/lib/uploadPhoto";
import { useEffect, useRef, useState } from "react";

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

export default function ScanPage() {
  const [sessions, setSessions] = useState<ScanSession[] | null>(null);
  const [activeSessionId, setActiveSessionId] = useState<string | null>(null);
  const [savedThisSession, setSavedThisSession] = useState(0);

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
    fetch("/api/sessions")
      .then((r) => r.json())
      .then((data: ScanSession[]) => {
        setSessions(data);
        if (stored && data.some((s) => s.id === stored)) {
          setActiveSessionId(stored);
        }
      });
    fetch("/api/shelf-locations")
      .then((r) => r.json())
      .then(setShelfLocations);
    fetch("/api/box-sizes")
      .then((r) => r.json())
      .then(setBoxSizes);
  }, []);

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
    setActiveSessionId(null);
    setSavedThisSession(0);
    setSessions((prev) =>
      (prev ?? []).filter((s) => s.id !== activeSessionId)
    );
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
        </div>
      </div>

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
