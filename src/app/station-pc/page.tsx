"use client";

import { QrCode } from "@/components/ScreenCodes";
import { LoaderCircle, Monitor, MousePointer2, ScanBarcode, Smartphone } from "lucide-react";
import Link from "next/link";
import { useEffect, useRef, useState } from "react";

// A station PC with no one signed in (Cristian, 2026-10-26). Shows a code;
// whoever is starting here scans it with their own handheld and types
// their PIN there, and this PC signs in as them and opens the station
// page. Reached signed out (proxy.ts), and only works on a PC set up for
// it (the station_device cookie, see src/lib/stationSignIn.ts).
//
// Checks for the PIN every IDLE_CHECK_MS, and every FAST_CHECK_MS once
// someone has scanned, so a sign-in lands within a second or so without
// a quiet station calling the app all day.
const IDLE_CHECK_MS = 4_000;
const FAST_CHECK_MS = 1_000;
// Swap in a new code this long before the old one runs out.
const RENEW_BEFORE_MS = 60_000;
// Nobody scanned or touched this PC for this long: stop checking and ask
// for a mouse move or a key instead (Cristian, 2026-11-01: a QR screen
// left up all night was still calling the app every 4s).
const SLEEP_AFTER_MS = 15 * 60_000;

type Shown = { code: string; expiresAt: number; stationId: string; stationName: string };

export default function StationPcSignIn() {
  const [shown, setShown] = useState<Shown | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notStation, setNotStation] = useState(false);
  const [scannedBy, setScannedBy] = useState<string | null>(null);
  const [signedIn, setSignedIn] = useState<string | null>(null);
  const [asleep, setAsleep] = useState(false);
  const shownRef = useRef<Shown | null>(null);
  const scannedRef = useRef(false);
  const lastInputAt = useRef(0);

  async function newCode() {
    try {
      const res = await fetch("/api/station-pc/code", { method: "POST", cache: "no-store" });
      const data = await res.json().catch(() => ({}));
      if (res.status === 403) {
        setNotStation(true);
        setError(data.error ?? "This PC isn't set up as a station.");
        return;
      }
      if (!res.ok) throw new Error(data.error ?? "Couldn't get a sign-in code.");
      const next: Shown = { code: data.code, expiresAt: new Date(data.expiresAt).getTime(), stationId: data.stationId, stationName: data.stationName };
      shownRef.current = next;
      scannedRef.current = false;
      setShown(next);
      setScannedBy(null);
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Couldn't reach the app. Check the internet.");
    }
  }

  async function check() {
    const current = shownRef.current;
    if (!current) return newCode();
    if (current.expiresAt - Date.now() < RENEW_BEFORE_MS && !scannedRef.current) return newCode();
    try {
      const res = await fetch(`/api/station-pc/code?code=${encodeURIComponent(current.code)}`, { cache: "no-store" });
      const data = await res.json().catch(() => ({}));
      if (res.status === 403) {
        setNotStation(true);
        setError(data.error ?? "This PC isn't set up as a station.");
        return;
      }
      if (!res.ok) throw new Error(data.error ?? "Couldn't check the code.");
      if (data.status === "signed-in") {
        setSignedIn(data.username);
        // A full load, so the station page starts fresh with the new
        // sign-in cookie.
        // eslint-disable-next-line @next/next/no-location-assign-relative-destination
        window.location.href = `/station/${data.stationId}`;
        return "done";
      }
      if (data.status === "expired") return newCode();
      scannedRef.current = Boolean(data.scannedBy);
      setScannedBy(data.scannedBy ?? null);
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Couldn't reach the app. Check the internet.");
    }
  }

  // Mouse or keys: someone's here. Wakes a sleeping screen.
  useEffect(() => {
    let last = 0;
    function touched() {
      const t = Date.now();
      if (t - last < 1000) return;
      last = t;
      lastInputAt.current = t;
      setAsleep(false);
    }
    const events = ["pointermove", "pointerdown", "keydown", "wheel", "touchstart"] as const;
    for (const e of events) window.addEventListener(e, touched, { passive: true });
    return () => {
      for (const e of events) window.removeEventListener(e, touched);
    };
  }, []);

  useEffect(() => {
    if (asleep) return;
    let stopped = false;
    let timer: ReturnType<typeof setTimeout>;
    lastInputAt.current = Date.now();
    async function loop() {
      if (!scannedRef.current && Date.now() - lastInputAt.current >= SLEEP_AFTER_MS) {
        setAsleep(true);
        return;
      }
      const result = await check();
      if (stopped || result === "done") return;
      timer = setTimeout(loop, scannedRef.current ? FAST_CHECK_MS : IDLE_CHECK_MS);
    }
    void loop();
    return () => {
      stopped = true;
      clearTimeout(timer);
    };
    // Runs on load and on each wake; check() reads the latest code through
    // shownRef (one that ran out is swapped for a new one).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [asleep]);

  if (notStation) {
    return (
      <main className="mx-auto flex min-h-dvh max-w-md flex-col items-center justify-center gap-4 px-4 text-center">
        <Monitor className="size-10 text-muted-foreground" aria-hidden />
        <p className="text-lg font-semibold text-foreground">{error}</p>
        <Link href="/login" className="font-medium text-primary underline">
          Sign in with a password
        </Link>
      </main>
    );
  }

  return (
    <main className="flex min-h-dvh flex-col items-center justify-center gap-5 bg-background px-4 py-6 text-center">
      <div>
        <p className="text-sm font-medium uppercase tracking-wide text-muted-foreground">Nobody&apos;s signed in at</p>
        <h1 className="text-4xl font-bold tracking-tight text-foreground">{shown?.stationName ?? "this station"}</h1>
      </div>

      {asleep && !signedIn ? (
        <p className="flex max-w-md items-center gap-3 rounded-xl bg-blue-50 px-6 py-5 text-2xl font-semibold text-primary">
          <MousePointer2 className="size-8 shrink-0" aria-hidden />
          Move the mouse or press a key to sign in
        </p>
      ) : signedIn ? (
        <p className="flex items-center gap-2 text-2xl font-semibold text-success">
          <LoaderCircle className="size-6 animate-spin" aria-hidden />
          Signing in as {signedIn}…
        </p>
      ) : shown ? (
        <>
          <div className="rounded-2xl border border-border bg-white p-5 shadow-sm">
            <QrCode text={shown.code} size={300} className="mx-auto block" />
            <p className="mt-2 font-mono text-lg tracking-widest text-zinc-700">{shown.code}</p>
          </div>
          {scannedBy ? (
            <p className="flex items-center gap-2 rounded-xl bg-blue-50 px-5 py-3 text-xl font-semibold text-primary">
              <Smartphone className="size-6" aria-hidden />
              {scannedBy}: type your PIN on your scanner
            </p>
          ) : (
            <ol className="flex flex-col gap-2 text-left text-xl text-foreground">
              <li className="flex items-center gap-3">
                <ScanBarcode className="size-6 shrink-0 text-primary" aria-hidden />
                1. Scan this with your scanner
              </li>
              <li className="flex items-center gap-3">
                <Smartphone className="size-6 shrink-0 text-primary" aria-hidden />
                2. Type your PIN on your scanner
              </li>
            </ol>
          )}
          <p className="max-w-md text-sm text-muted-foreground">
            First time? Your scanner asks you to make a PIN (you&apos;ll need your password once). Any scan box on the
            scanner works.
          </p>
        </>
      ) : (
        <LoaderCircle className="size-8 animate-spin text-muted-foreground" aria-hidden />
      )}

      {error && <p className="text-base font-medium text-danger">{error}</p>}

      <Link
        href={`/login?next=${encodeURIComponent(shown ? `/station/${shown.stationId}` : "/station")}`}
        className="text-sm text-muted-foreground underline"
      >
        Sign in with a password instead
      </Link>
    </main>
  );
}
