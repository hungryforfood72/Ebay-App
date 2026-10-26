"use client";

import { Button } from "@/components/ui/Button";
import { Field, Input } from "@/components/ui/Input";
import { HANDHELD_STATION_KEYS, PIN_PATTERN } from "@/lib/stationSignInCode";
import { CircleCheck, LoaderCircle, Monitor } from "lucide-react";
import { useEffect, useRef, useState } from "react";

// The handheld half of scan-to-sign-in (src/lib/stationSignIn.ts): opened
// by ScanField when a station screen's SIGNIN- code is scanned into any
// scan box. Asks for this person's PIN (or has them make one first, with
// their password), and on the right PIN the station PC signs in as them
// and this handheld switches to printing at that station.

// Fired on window after a station sign-in, with the station's id, so a
// page already open (List, Shipping, Bins) switches to it without a reload.
export const STATION_CHOSEN_EVENT = "station-chosen";

export function rememberHandheldStation(stationId: string) {
  for (const key of HANDHELD_STATION_KEYS) {
    try {
      localStorage.setItem(key, stationId);
    } catch {
      // Not remembered on this device; the PC still signed in.
    }
  }
  window.dispatchEvent(new CustomEvent(STATION_CHOSEN_EVENT, { detail: stationId }));
}

// Calls onChosen with the station's id whenever this handheld signs in at
// a station (rememberHandheldStation).
export function useStationChosen(onChosen: (stationId: string) => void) {
  const ref = useRef(onChosen);
  useEffect(() => {
    ref.current = onChosen;
  });
  useEffect(() => {
    const listener = (e: Event) => ref.current((e as CustomEvent<string>).detail);
    window.addEventListener(STATION_CHOSEN_EVENT, listener);
    return () => window.removeEventListener(STATION_CHOSEN_EVENT, listener);
  }, []);
}

type Step =
  | { kind: "checking" }
  | { kind: "pin"; stationName: string; username: string }
  | { kind: "setup"; stationName: string; username: string }
  | { kind: "done"; stationName: string }
  | { kind: "error"; message: string };

const DONE_CLOSE_MS = 2_500;

export function StationSignInDialog({ code, onClose }: { code: string; onClose: () => void }) {
  const [step, setStep] = useState<Step>({ kind: "checking" });
  const [pin, setPin] = useState("");
  const [pin2, setPin2] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const closeRef = useRef(onClose);
  useEffect(() => {
    closeRef.current = onClose;
  });

  useEffect(() => {
    let cancelled = false;
    fetch("/api/station-signin/check", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ code }),
    })
      .then(async (res) => {
        const data = await res.json().catch(() => ({}));
        if (cancelled) return;
        if (!res.ok) setStep({ kind: "error", message: data.error ?? "Couldn't read that station code." });
        else setStep({ kind: data.hasPin ? "pin" : "setup", stationName: data.stationName, username: data.username });
      })
      .catch(() => !cancelled && setStep({ kind: "error", message: "Couldn't reach the app. Check the Wi-Fi." }));
    return () => {
      cancelled = true;
    };
  }, [code]);

  useEffect(() => {
    if (step.kind !== "done") return;
    const t = setTimeout(() => closeRef.current(), DONE_CLOSE_MS);
    return () => clearTimeout(t);
  }, [step.kind]);

  async function claim(withPin: string, stationName: string) {
    const res = await fetch("/api/station-signin/claim", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ code, pin: withPin }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      // A used-up code can't be retried here; anything else (wrong PIN) can.
      if (res.status === 410 || res.status === 409) setStep({ kind: "error", message: data.error });
      else setError(data.error ?? "Couldn't sign in.");
      setPin("");
      return;
    }
    rememberHandheldStation(data.stationId);
    setStep({ kind: "done", stationName: data.stationName ?? stationName });
  }

  async function submitPin(e: React.FormEvent) {
    e.preventDefault();
    if (step.kind !== "pin") return;
    setBusy(true);
    setError(null);
    try {
      await claim(pin, step.stationName);
    } catch {
      setError("Couldn't reach the app. Check the Wi-Fi.");
    } finally {
      setBusy(false);
    }
  }

  async function submitSetup(e: React.FormEvent) {
    e.preventDefault();
    if (step.kind !== "setup") return;
    if (!PIN_PATTERN.test(pin)) return setError("Your PIN has to be 4 to 6 numbers.");
    if (pin !== pin2) return setError("The two PINs don't match.");
    setBusy(true);
    setError(null);
    try {
      const res = await fetch("/api/station-signin/pin", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ password, pin }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        setError(data.error ?? "Couldn't save your PIN.");
        return;
      }
      setPassword("");
      setPin2("");
      await claim(pin, step.stationName);
    } catch {
      setError("Couldn't reach the app. Check the Wi-Fi.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-labelledby="station-signin-title"
      className="fixed inset-0 z-50 flex items-end justify-center bg-black/50 p-4 sm:items-center"
    >
      <div className="w-full max-w-md rounded-2xl bg-surface p-5 shadow-xl">
        {step.kind === "checking" && (
          <p className="flex items-center gap-2 text-base text-muted-foreground">
            <LoaderCircle className="size-5 animate-spin" aria-hidden /> Reading the station code…
          </p>
        )}

        {step.kind === "error" && (
          <>
            <p id="station-signin-title" className="text-lg font-bold text-foreground">
              Didn&apos;t sign in
            </p>
            <p className="mt-2 text-base text-foreground">{step.message}</p>
            <Button className="mt-4" block size="lg" onClick={onClose}>
              OK
            </Button>
          </>
        )}

        {step.kind === "done" && (
          <div className="flex flex-col items-center gap-2 py-2 text-center">
            <CircleCheck className="size-12 text-success" aria-hidden />
            <p id="station-signin-title" className="text-xl font-bold text-foreground">
              Signed in at {step.stationName}
            </p>
            <p className="text-sm text-muted-foreground">Your labels print there now.</p>
          </div>
        )}

        {step.kind === "pin" && (
          <form onSubmit={submitPin} className="flex flex-col gap-4">
            <div>
              <p id="station-signin-title" className="flex items-center gap-2 text-lg font-bold text-foreground">
                <Monitor className="size-5 text-primary" aria-hidden />
                Sign in at {step.stationName}
              </p>
              <p className="mt-1 text-sm text-muted-foreground">As {step.username}. Not you? Cancel and sign this scanner out.</p>
            </div>
            <Field label="Your PIN">
              <Input
                type="password"
                inputMode="numeric"
                autoComplete="off"
                autoFocus
                size="lg"
                maxLength={6}
                value={pin}
                onChange={(e) => setPin(e.target.value.replace(/\D/g, ""))}
              />
            </Field>
            {error && <p className="text-sm font-medium text-danger">{error}</p>}
            <div className="flex gap-2">
              <Button type="button" variant="outline" size="lg" onClick={onClose}>
                Cancel
              </Button>
              <Button type="submit" size="lg" block disabled={busy || !PIN_PATTERN.test(pin)}>
                {busy ? "Signing in…" : "Sign in"}
              </Button>
            </div>
          </form>
        )}

        {step.kind === "setup" && (
          <form onSubmit={submitSetup} className="flex flex-col gap-3">
            <div>
              <p id="station-signin-title" className="text-lg font-bold text-foreground">
                Make your PIN
              </p>
              <p className="mt-1 text-sm text-muted-foreground">
                {step.username}: pick 4 to 6 numbers. From now on you sign in at any station by scanning its screen and
                typing this PIN. Your password is needed just this once.
              </p>
            </div>
            <Field label="Your password">
              <Input type="password" autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} />
            </Field>
            <Field label="New PIN">
              <Input
                type="password"
                inputMode="numeric"
                autoComplete="off"
                maxLength={6}
                value={pin}
                onChange={(e) => setPin(e.target.value.replace(/\D/g, ""))}
              />
            </Field>
            <Field label="Same PIN again">
              <Input
                type="password"
                inputMode="numeric"
                autoComplete="off"
                maxLength={6}
                value={pin2}
                onChange={(e) => setPin2(e.target.value.replace(/\D/g, ""))}
              />
            </Field>
            {error && <p className="text-sm font-medium text-danger">{error}</p>}
            <div className="flex gap-2">
              <Button type="button" variant="outline" size="lg" onClick={onClose}>
                Cancel
              </Button>
              <Button type="submit" size="lg" block disabled={busy || !password || !pin || !pin2}>
                {busy ? "Saving…" : `Save and sign in`}
              </Button>
            </div>
          </form>
        )}
      </div>
    </div>
  );
}
