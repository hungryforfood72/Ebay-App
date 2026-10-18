"use client";

import BarcodeScanner from "@/components/BarcodeScanner";
import { Alert } from "@/components/ui/Alert";
import { AppShell } from "@/components/ui/AppShell";
import { Badge } from "@/components/ui/Badge";
import { Button } from "@/components/ui/Button";
import { Card, SectionHeader } from "@/components/ui/Card";
import { Input } from "@/components/ui/Input";
import type { DeliveriesResponse, DeliveryView } from "@/lib/delivery/deliveries";
import { deliveryLabelsDocument } from "@/lib/delivery/label";
import { uploadPhoto } from "@/lib/uploadPhoto";
import { printPage } from "@/lib/warehouse/labelPrint";
import { Camera, CircleCheck, MapPin, Navigation, Phone, Printer, RefreshCw, ScanBarcode, Truck } from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";

// Epic Steals free local delivery (src/lib/delivery). Picked local delivery
// orders get a 4x6 label, then "Start route" orders the stops from where
// the phone is. At each stop the driver scans the bag's label (it has to be
// this stop's), takes a photo, and the app fulfills the Shopify order and
// emails the customer the photo.

function addressLine(d: Pick<DeliveryView, "address1" | "address2" | "city" | "province" | "zip">): string {
  return [d.address1, d.address2, d.city, [d.province, d.zip].filter(Boolean).join(" ")].filter(Boolean).join(", ");
}

function mapsTo(d: DeliveryView): string {
  return `https://www.google.com/maps/dir/?api=1&travelmode=driving&destination=${encodeURIComponent(addressLine(d))}`;
}

// Google Maps takes up to 9 stops between start and destination in a link.
function mapsRoute(stops: DeliveryView[], backTo: { lat: number; lng: number } | null): string | null {
  if (stops.length === 0) return null;
  const places = stops.slice(0, 10).map(addressLine);
  const destination = backTo ? `${backTo.lat},${backTo.lng}` : places.pop()!;
  const waypoints = places.slice(0, 9);
  return (
    `https://www.google.com/maps/dir/?api=1&travelmode=driving&destination=${encodeURIComponent(destination)}` +
    (waypoints.length ? `&waypoints=${encodeURIComponent(waypoints.join("|"))}` : "")
  );
}

function normalizeCode(text: string): string {
  return text.trim().toUpperCase().replace(/\s+/g, "");
}

export default function DeliveriesPage() {
  const [data, setData] = useState<DeliveriesResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [selected, setSelected] = useState<Set<string> | null>(null);
  const [backToShop, setBackToShop] = useState(false);
  const [starting, setStarting] = useState(false);

  const load = useCallback(async (sync: boolean) => {
    setLoading(true);
    try {
      const res = await fetch(`/api/deliveries${sync ? "?sync=1" : ""}`);
      const json = await res.json();
      if (!res.ok) throw new Error(json.error ?? "Couldn't load deliveries.");
      setData(json);
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Couldn't load deliveries.");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    // Initial load from Shopify, not a reaction to state we own.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    load(true);
  }, [load]);

  const waiting = useMemo(() => data?.deliveries.filter((d) => d.status === "ready" || d.status === "failed") ?? [], [data]);
  const onRoute = useMemo(() => (data?.deliveries.filter((d) => d.status === "out") ?? []).sort((a, b) => (a.stop ?? 0) - (b.stop ?? 0)), [data]);
  const delivered = data?.deliveries.filter((d) => d.status === "delivered") ?? [];
  // Everything waiting starts checked.
  const chosen = selected ?? new Set(waiting.map((d) => d.id));

  async function printLabels(list: DeliveryView[]) {
    if (list.length === 0) return;
    try {
      await printPage(deliveryLabelsDocument(list, data?.shipFrom ?? null), { width: "4in", height: "6in" });
      await fetch("/api/deliveries/labels", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ids: list.map((d) => d.id) }),
      });
      load(false);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Printing failed.");
    }
  }

  async function startRoute() {
    const ids = waiting.filter((d) => chosen.has(d.id)).map((d) => d.id);
    if (ids.length === 0) return;
    setStarting(true);
    setError(null);
    // Start from where the phone is; without it the server starts at the shop.
    const start = await new Promise<{ lat: number; lng: number } | null>((resolve) => {
      if (!navigator.geolocation) return resolve(null);
      navigator.geolocation.getCurrentPosition(
        (p) => resolve({ lat: p.coords.latitude, lng: p.coords.longitude }),
        () => resolve(null),
        { enableHighAccuracy: true, timeout: 10_000, maximumAge: 60_000 }
      );
    });
    try {
      const res = await fetch("/api/deliveries/run", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ids, start, endAtStart: backToShop }),
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error ?? "Couldn't start the route.");
      setSelected(null);
      await load(false);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Couldn't start the route.");
    } finally {
      setStarting(false);
    }
  }

  async function finishRoute() {
    if (!data?.run) return;
    if (onRoute.length > 0 && !confirm(`End the route? ${onRoute.length} stop(s) not delivered go back to the list.`)) return;
    await fetch("/api/deliveries/run/finish", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ runId: data.run.id }),
    });
    load(false);
  }

  return (
    <AppShell
      title="Local deliveries"
      subtitle="Epic Steals free local delivery"
      width="medium"
      actions={
        <Button variant="outline" onClick={() => load(true)} disabled={loading}>
          <RefreshCw className={loading ? "size-4 animate-spin" : "size-4"} aria-hidden />
          Refresh
        </Button>
      }
    >
      <div className="flex flex-col gap-6">
        {error && <Alert tone="danger">{error}</Alert>}
        {data && !data.configured && <Alert tone="warning">The Shopify store isn&apos;t connected here, so there are no delivery orders to show.</Alert>}
        {data && data.missingCustomerData > 0 && (
          <Alert tone="warning">
            {data.missingCustomerData} local delivery order{data.missingCustomerData === 1 ? "" : "s"} came in without an address. Shopify
            isn&apos;t sharing customer names and addresses with the app yet: turn on protected customer data (name, address, email,
            phone) for the store app on the Shopify Dev Dashboard.
          </Alert>
        )}
        {data?.syncError && <Alert tone="danger">Couldn&apos;t get orders from Shopify: {data.syncError}</Alert>}
        {data && !data.emailReady && (
          <Alert tone="info">
            Delivery photo emails are off until EPIC_STEALS_GMAIL_USER and EPIC_STEALS_GMAIL_APP_PASSWORD are set in Vercel. Deliveries
            still work; the emails can be sent later from the list below.
          </Alert>
        )}

        {data?.run ? (
          <RunView
            stops={onRoute}
            backTo={data.run.endAtStart ? data.run.start : null}
            onChange={() => load(false)}
            onFinish={finishRoute}
          />
        ) : (
          <section>
            <SectionHeader
              title="Waiting for delivery"
              action={<Badge tone={waiting.length ? "warning" : "neutral"}>{waiting.length}</Badge>}
            />
            {waiting.length === 0 ? (
              <Card>
                <p className="text-sm text-muted-foreground">{data ? "No local delivery orders waiting." : "Loading…"}</p>
              </Card>
            ) : (
              <>
                <Card padded={false} className="divide-y divide-border">
                  {waiting.map((d) => (
                    <label key={d.id} className="flex cursor-pointer gap-3 p-4">
                      <input
                        type="checkbox"
                        className="mt-1 size-5"
                        checked={chosen.has(d.id)}
                        onChange={(e) => {
                          const next = new Set(chosen);
                          if (e.target.checked) next.add(d.id);
                          else next.delete(d.id);
                          setSelected(next);
                        }}
                      />
                      <div className="min-w-0 flex-1">
                        <p className="font-semibold text-foreground">
                          {d.name} <span className="font-normal text-muted-foreground">· {d.orderName}</span>
                        </p>
                        <p className="text-sm text-foreground">{addressLine(d)}</p>
                        <div className="mt-1.5 flex flex-wrap gap-1.5">
                          <Badge tone={d.picked >= d.units ? "success" : "warning"}>
                            Picked {d.picked}/{d.units}
                          </Badge>
                          {d.labelPrintedAt ? <Badge tone="success">Label printed</Badge> : <Badge>No label yet</Badge>}
                          {d.lat == null && <Badge tone="danger">Address not found on the map</Badge>}
                          {d.status === "failed" && <Badge tone="danger">Last try: {d.failedNote}</Badge>}
                        </div>
                      </div>
                      <Button
                        size="sm"
                        variant="outline"
                        onClick={(e) => {
                          e.preventDefault();
                          printLabels([d]);
                        }}
                      >
                        <Printer className="size-4" aria-hidden />
                        Label
                      </Button>
                    </label>
                  ))}
                </Card>
                <div className="mt-4 flex flex-col gap-3">
                  <label className="flex items-center gap-2 text-sm text-foreground">
                    <input type="checkbox" className="size-4" checked={backToShop} onChange={(e) => setBackToShop(e.target.checked)} />
                    Come back to the shop at the end
                  </label>
                  <div className="flex flex-wrap gap-3">
                    <Button variant="outline" onClick={() => printLabels(waiting.filter((d) => chosen.has(d.id)))} disabled={chosen.size === 0}>
                      <Printer className="size-4" aria-hidden />
                      Print {chosen.size} label{chosen.size === 1 ? "" : "s"}
                    </Button>
                    <Button size="lg" onClick={startRoute} disabled={starting || chosen.size === 0}>
                      <Truck className="size-5" aria-hidden />
                      {starting ? "Planning the route…" : `Start deliveries (${chosen.size})`}
                    </Button>
                  </div>
                  {waiting.some((d) => chosen.has(d.id) && d.picked < d.units) && (
                    <p className="text-xs text-warning">Some checked orders aren&apos;t fully picked yet.</p>
                  )}
                </div>
              </>
            )}
          </section>
        )}

        {delivered.length > 0 && <DeliveredList deliveries={delivered} onChange={() => load(false)} />}
      </div>
    </AppShell>
  );
}

// ---------------------------------------------------------------------------
// The route in progress
// ---------------------------------------------------------------------------

function RunView({
  stops,
  backTo,
  onChange,
  onFinish,
}: {
  stops: DeliveryView[];
  backTo: { lat: number; lng: number } | null;
  onChange: () => void;
  onFinish: () => void;
}) {
  const current = stops[0] ?? null;
  const routeLink = mapsRoute(stops, backTo);
  return (
    <section className="flex flex-col gap-4">
      <SectionHeader
        title="On the route"
        description={stops.length ? `${stops.length} stop${stops.length === 1 ? "" : "s"} left` : "All stops done"}
        action={
          <Button size="sm" variant="danger-ghost" onClick={onFinish}>
            End route
          </Button>
        }
      />
      {routeLink && (
        <a href={routeLink} target="_blank" rel="noreferrer" className="text-sm font-medium text-primary underline">
          Open the whole route in Google Maps
        </a>
      )}
      {current ? (
        <StopCard key={current.id} stop={current} others={stops.slice(1)} onDone={onChange} />
      ) : (
        <Card>
          <p className="flex items-center gap-2 font-semibold text-foreground">
            <CircleCheck className="size-5 text-success" aria-hidden />
            Every stop is done. Nice work!
          </p>
        </Card>
      )}
      {stops.length > 1 && (
        <Card padded={false} className="divide-y divide-border">
          {stops.slice(1).map((s) => (
            <div key={s.id} className="flex items-center gap-3 p-3">
              <span className="flex size-8 items-center justify-center rounded-full bg-muted font-bold text-foreground">{s.letter}</span>
              <div className="min-w-0 flex-1">
                <p className="text-sm font-medium text-foreground">{s.name}</p>
                <p className="truncate text-xs text-muted-foreground">{addressLine(s)}</p>
              </div>
            </div>
          ))}
        </Card>
      )}
    </section>
  );
}

// One stop: navigate, scan the bag (must be this stop's), photo, done.
function StopCard({ stop, others, onDone }: { stop: DeliveryView; others: DeliveryView[]; onDone: () => void }) {
  const [scanning, setScanning] = useState(false);
  const [typed, setTyped] = useState("");
  const [scanned, setScanned] = useState<string | null>(null);
  const [message, setMessage] = useState<{ tone: "danger" | "success"; text: string } | null>(null);
  const [busy, setBusy] = useState<"photo" | "failed" | null>(null);

  function checkCode(raw: string) {
    const code = normalizeCode(raw);
    setScanning(false);
    if (code === stop.code) {
      setScanned(code);
      setMessage({ tone: "success", text: `Right bag for stop ${stop.letter}. Drop it off and take the photo.` });
      return;
    }
    const other = others.find((o) => o.code === code);
    setMessage({
      tone: "danger",
      text: other
        ? `Wrong bag: that's stop ${other.letter} (${other.name}). Grab the bag for ${stop.name}, label ${stop.code}.`
        : `That's not this stop's label (${code}). Look for ${stop.code}.`,
    });
  }

  async function photoTaken(file: File | undefined) {
    if (!file || !scanned) return;
    setBusy("photo");
    setMessage(null);
    try {
      const photoUrl = await uploadPhoto(file);
      const res = await fetch(`/api/deliveries/${stop.id}/delivered`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ code: scanned, photoUrl }),
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error ?? "Couldn't save the delivery.");
      onDone();
    } catch (e) {
      setMessage({ tone: "danger", text: e instanceof Error ? e.message : "Couldn't save the delivery." });
    } finally {
      setBusy(null);
    }
  }

  async function couldntDeliver() {
    const note = prompt("Why couldn't it be delivered? (gate locked, nobody home...)");
    if (note == null) return;
    setBusy("failed");
    try {
      const res = await fetch(`/api/deliveries/${stop.id}/failed`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ note }),
      });
      if (!res.ok) throw new Error((await res.json()).error ?? "Couldn't save that.");
      onDone();
    } catch (e) {
      setMessage({ tone: "danger", text: e instanceof Error ? e.message : "Couldn't save that." });
    } finally {
      setBusy(null);
    }
  }

  return (
    <Card className="flex flex-col gap-4">
      <div className="flex items-start gap-3">
        <span className="flex size-12 shrink-0 items-center justify-center rounded-full bg-primary text-xl font-bold text-primary-foreground">
          {stop.letter}
        </span>
        <div className="min-w-0 flex-1">
          <p className="text-lg font-semibold text-foreground">{stop.name}</p>
          <p className="text-foreground">{addressLine(stop)}</p>
          <p className="text-sm text-muted-foreground">
            {stop.orderName} · {stop.units} item{stop.units === 1 ? "" : "s"} · label {stop.code}
          </p>
          {stop.note && <p className="mt-1 text-sm font-medium text-warning">Note: {stop.note}</p>}
        </div>
      </div>

      <div className="flex flex-wrap gap-2">
        <a href={mapsTo(stop)} target="_blank" rel="noreferrer" className="inline-flex h-12 items-center gap-2 rounded-lg bg-primary px-5 font-medium text-primary-foreground">
          <Navigation className="size-5" aria-hidden />
          Navigate
        </a>
        {stop.phone && (
          <a href={`tel:${stop.phone}`} className="inline-flex h-12 items-center gap-2 rounded-lg border border-border px-4 font-medium text-foreground">
            <Phone className="size-5" aria-hidden />
            Call
          </a>
        )}
      </div>

      {message && <Alert tone={message.tone}>{message.text}</Alert>}

      {!scanned ? (
        <div className="flex flex-col gap-2">
          <p className="text-sm font-medium text-foreground">1. At the door, scan the bag&apos;s label</p>
          <Button size="xl" onClick={() => setScanning(true)}>
            <ScanBarcode className="size-5" aria-hidden />
            Scan package
          </Button>
          <form
            className="flex gap-2"
            onSubmit={(e) => {
              e.preventDefault();
              if (typed.trim()) checkCode(typed);
            }}
          >
            <Input placeholder={`Or type the label code (${stop.code})`} value={typed} onChange={(e) => setTyped(e.target.value)} />
            <Button type="submit" variant="outline">
              Check
            </Button>
          </form>
        </div>
      ) : (
        <div className="flex flex-col gap-2">
          <p className="text-sm font-medium text-foreground">2. Leave it and take a photo showing the package at the door</p>
          <label className="inline-flex h-14 cursor-pointer items-center justify-center gap-2 rounded-lg bg-success px-6 text-base font-medium text-white">
            <Camera className="size-5" aria-hidden />
            {busy === "photo" ? "Saving…" : "Take photo & mark delivered"}
            <input
              type="file"
              accept="image/*"
              capture="environment"
              className="hidden"
              disabled={busy !== null}
              onChange={(e) => photoTaken(e.target.files?.[0])}
            />
          </label>
        </div>
      )}

      <Button variant="danger-ghost" onClick={couldntDeliver} disabled={busy !== null}>
        Couldn&apos;t deliver
      </Button>

      {scanning && <BarcodeScanner onDetected={checkCode} onClose={() => setScanning(false)} />}
    </Card>
  );
}

// ---------------------------------------------------------------------------
// Delivered in the last 3 days
// ---------------------------------------------------------------------------

function DeliveredList({ deliveries, onChange }: { deliveries: DeliveryView[]; onChange: () => void }) {
  const [retrying, setRetrying] = useState<string | null>(null);

  async function retry(id: string) {
    setRetrying(id);
    try {
      await fetch(`/api/deliveries/${id}/follow-up`, { method: "POST" });
      onChange();
    } finally {
      setRetrying(null);
    }
  }

  return (
    <section>
      <SectionHeader title="Delivered" description="Last 3 days" />
      <Card padded={false} className="divide-y divide-border">
        {[...deliveries]
          .sort((a, b) => (b.deliveredAt ?? "").localeCompare(a.deliveredAt ?? ""))
          .map((d) => (
            <div key={d.id} className="flex gap-3 p-4">
              {d.photoUrl ? (
                <a href={d.photoUrl} target="_blank" rel="noreferrer" className="shrink-0">
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  <img src={d.photoUrl.replace("/image/upload/", "/image/upload/c_fill,w_160,h_160/")} alt="Delivery photo" className="size-16 rounded-lg object-cover" />
                </a>
              ) : (
                <MapPin className="size-6 text-muted-foreground" aria-hidden />
              )}
              <div className="min-w-0 flex-1">
                <p className="font-medium text-foreground">
                  {d.name} <span className="font-normal text-muted-foreground">· {d.orderName}</span>
                </p>
                <p className="text-xs text-muted-foreground">
                  {d.deliveredAt ? new Date(d.deliveredAt).toLocaleString([], { weekday: "short", hour: "numeric", minute: "2-digit" }) : ""}
                  {d.deliveredBy ? ` by ${d.deliveredBy}` : ""}
                </p>
                <div className="mt-1 flex flex-wrap gap-1.5">
                  <Badge tone={d.shopifyDoneAt ? "success" : "warning"}>{d.shopifyDoneAt ? "Shopify updated" : "Shopify not updated"}</Badge>
                  <Badge tone={d.emailSentAt ? "success" : "warning"}>{d.emailSentAt ? "Photo emailed" : "Not emailed"}</Badge>
                </div>
                {d.followUpError && (
                  <div className="mt-2 flex flex-wrap items-center gap-2">
                    <p className="text-xs text-danger">{d.followUpError}</p>
                    <Button size="sm" variant="outline" onClick={() => retry(d.id)} disabled={retrying === d.id}>
                      {retrying === d.id ? "Retrying…" : "Retry"}
                    </Button>
                  </div>
                )}
              </div>
            </div>
          ))}
      </Card>
    </section>
  );
}
