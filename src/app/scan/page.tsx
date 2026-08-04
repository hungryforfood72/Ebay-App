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

const ACTIVE_SESSION_KEY = "ebay-tool.activeScanSessionId";
const RECENT_LOCATIONS_KEY = "ebay-tool.recentShelfLocations";

function loadRecentLocations(): string[] {
  if (typeof window === "undefined") return [];
  try {
    return JSON.parse(localStorage.getItem(RECENT_LOCATIONS_KEY) ?? "[]");
  } catch {
    return [];
  }
}

function rememberLocation(location: string) {
  const recent = loadRecentLocations().filter((l) => l !== location);
  recent.unshift(location);
  localStorage.setItem(
    RECENT_LOCATIONS_KEY,
    JSON.stringify(recent.slice(0, 12))
  );
}

export default function ScanPage() {
  const [sessions, setSessions] = useState<ScanSession[] | null>(null);
  const [activeSessionId, setActiveSessionId] = useState<string | null>(null);
  const [savedThisSession, setSavedThisSession] = useState(0);

  const [photos, setPhotos] = useState<Photo[]>([]);
  const [upc, setUpc] = useState("");
  const [quantity, setQuantity] = useState("1");
  const [isMultipack, setIsMultipack] = useState(false);
  const [packSize, setPackSize] = useState("");
  const [expirationDate, setExpirationDate] = useState("");
  const [shelfLocation, setShelfLocation] = useState("");
  const [recentLocations, setRecentLocations] = useState<string[]>([]);

  const [showScanner, setShowScanner] = useState(false);
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    // Initial hydration from localStorage/API on mount, not a reaction to
    // state we own.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setRecentLocations(loadRecentLocations());
    const stored = localStorage.getItem(ACTIVE_SESSION_KEY);
    fetch("/api/sessions")
      .then((r) => r.json())
      .then((data: ScanSession[]) => {
        setSessions(data);
        if (stored && data.some((s) => s.id === stored)) {
          setActiveSessionId(stored);
        }
      });
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

  function handleFiles(files: FileList | null) {
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

  function removePhoto(id: string) {
    setPhotos((prev) => prev.filter((p) => p.id !== id));
  }

  function resetForm() {
    setPhotos([]);
    setUpc("");
    setQuantity("1");
    setIsMultipack(false);
    setPackSize("");
    setExpirationDate("");
    setShelfLocation("");
    if (fileInputRef.current) fileInputRef.current.value = "";
  }

  async function saveItem() {
    setMessage(null);

    if (!upc.trim()) return setMessage("Scan or enter a UPC first.");
    if (!shelfLocation.trim()) return setMessage("Shelf location is required.");
    if (isMultipack && !packSize) return setMessage("Enter a pack size.");
    if (photos.some((p) => p.status === "uploading")) {
      return setMessage("Photos are still uploading, hang on a sec.");
    }

    setSaving(true);
    try {
      const res = await fetch("/api/items", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          upc: upc.trim(),
          quantity: Number(quantity) || 1,
          isMultipack,
          packSize: isMultipack ? Number(packSize) : null,
          expirationDate: expirationDate || null,
          shelfLocation: shelfLocation.trim(),
          photoUrls: photos
            .filter((p) => p.status === "done")
            .map((p) => p.cloudinaryUrl),
          scanSessionId: activeSessionId,
        }),
      });

      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        throw new Error(err.error ?? "Save failed.");
      }

      rememberLocation(shelfLocation.trim());
      setRecentLocations(loadRecentLocations());
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

  return (
    <main className="mx-auto flex min-h-dvh max-w-md flex-col gap-4 p-4 pb-24">
      <div className="flex items-center justify-between">
        <h1 className="text-lg font-semibold">
          Scanning · {savedThisSession} saved
        </h1>
        <button
          type="button"
          onClick={finishSession}
          className="text-sm text-red-600 underline"
        >
          Finish session
        </button>
      </div>

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

      <section className="flex flex-col gap-1">
        <label className="text-sm font-medium">UPC</label>
        <div className="flex gap-2">
          <input
            type="text"
            inputMode="numeric"
            value={upc}
            onChange={(e) => setUpc(e.target.value)}
            placeholder="Scan or type UPC"
            className="flex-1 rounded border px-3 py-2"
          />
          <button
            type="button"
            onClick={() => setShowScanner(true)}
            className="rounded bg-black px-3 py-2 text-sm text-white"
          >
            Scan
          </button>
        </div>
      </section>

      <section className="flex gap-3">
        <div className="flex-1">
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
        <div className="flex flex-1 flex-col justify-end">
          <label className="flex items-center gap-2 py-2 text-sm font-medium">
            <input
              type="checkbox"
              checked={isMultipack}
              onChange={(e) => setIsMultipack(e.target.checked)}
            />
            Multi-pack
          </label>
        </div>
      </section>

      {isMultipack && (
        <section>
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
        </section>
      )}

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

      <section>
        <label className="text-sm font-medium">Shelf location</label>
        <input
          type="text"
          list="recent-locations"
          value={shelfLocation}
          onChange={(e) => setShelfLocation(e.target.value)}
          placeholder="e.g. Bin A3"
          className="w-full rounded border px-3 py-2"
        />
        <datalist id="recent-locations">
          {recentLocations.map((loc) => (
            <option key={loc} value={loc} />
          ))}
        </datalist>
      </section>

      {message && <p className="text-sm">{message}</p>}

      <button
        type="button"
        onClick={saveItem}
        disabled={saving}
        className="fixed inset-x-0 bottom-0 mx-auto max-w-md rounded-t-lg bg-black py-4 text-center text-white disabled:opacity-50"
      >
        {saving ? "Saving…" : "Save & scan next"}
      </button>

      {showScanner && (
        <BarcodeScanner
          onDetected={(text) => {
            setUpc(text);
            setShowScanner(false);
          }}
          onClose={() => setShowScanner(false)}
        />
      )}
    </main>
  );
}
