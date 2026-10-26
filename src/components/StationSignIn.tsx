"use client";

import { Button } from "@/components/ui/Button";
import { Field, Input } from "@/components/ui/Input";
import { HANDHELD_STATION_KEYS, PIN_PATTERN } from "@/lib/stationSignInCode";
import { PinPad } from "./PinPad";
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

// Fired on window after Sign out of a station, with its id: pages that
// were printing there drop it (useStationLeft).
export const STATION_LEFT_EVENT = "station-left";

export function forgetHandheldStation(stationId: string) {
  for (const key of HANDHELD_STATION_KEYS) {
    try {
      if (localStorage.getItem(key) === stationId) localStorage.removeItem(key);
    } catch {
      // Nothing remembered to forget.
    }
  }
  window.dispatchEvent(new CustomEvent(STATION_LEFT_EVENT, { detail: stationId }));
}

export function useStationLeft(onLeft: (stationId: string) => void) {
  const ref = useRef(onLeft);
  useEffect(() => {
    ref.current = onLeft;
  });
  useEffect(() => {
    const listener = (e: Event) => ref.current((e as CustomEvent<string>).detail);
    window.addEventListener(STATION_LEFT_EVENT, listener);
    return () => window.removeEventListener(STATION_LEFT_EVENT, listener);
  }, []);
}

// "Sign out" beside the station on the handheld (Cristian, 2026-10-26):
// signs you out of that station's PC (it goes back to its QR screen) and
// this handheld stops printing there.
export function StationSignOutButton({ stationId, stationName }: { stationId: string; stationName: string }) {
  const [busy, setBusy] = useState(false);
  async function signOut() {
    if (!confirm(`Sign out of ${stationName}?`)) return;
    setBusy(true);
    try {
      const res = await fetch(`/api/stations/${stationId}/sign-out`, { method: "POST" });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        alert(data.error ?? "Couldn't sign out of the station.");
        return;
      }
      // Pressed on the station PC itself: it's signed out, so on to its QR screen.
      if (data.thisDevice) {
        window.location.reload();
        return;
      }
      // Nobody was signed in there as you through the app (or it was by a
      // password before stations were tracked): say so instead of looking
      // like it worked.
      if (data.signedOut === 0) {
        alert(`You weren't signed in on the ${stationName} PC, so nothing changed there. If it still shows someone signed in, use Log out on the PC. This scanner stopped printing there.`);
      }
      forgetHandheldStation(stationId);
    } catch {
      alert("Couldn't reach the app. Check the Wi-Fi.");
    } finally {
      setBusy(false);
    }
  }
  return (
    <button
      type="button"
      onClick={signOut}
      disabled={busy}
      className="shrink-0 text-sm font-medium text-danger hover:underline disabled:opacity-50"
    >
      {busy ? "Signing out…" : "Sign out"}
    </button>
  );
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
  // otherStations: where they're signed in now; signing in here signs
  // them out there.
  | { kind: "pin"; stationName: string; username: string; otherStations: string[] }
  | { kind: "setup"; stationName: string; username: string; otherStations: string[] }
  | { kind: "done"; stationName: string }
  | { kind: "error"; message: string };

const DONE_CLOSE_MS = 2_500;

// "You're signed in at X: signing in here signs you out there."
function MovingNote({ from, to }: { from: string[]; to: string }) {
  if (from.length === 0) return null;
  return (
    <p className="mt-2 rounded-lg border border-amber-300 bg-amber-50 px-3 py-2 text-sm text-amber-950">
      You&apos;re signed in at <span className="font-semibold">{from.join(", ")}</span>. Signing in at {to} signs you out
      there.
    </p>
  );
}

export function StationSignInDialog({ code, onClose }: { code: string; onClose: () => void }) {
  const [step, setStep] = useState<Step>({ kind: "checking" });
  const [pin, setPin] = useState("");
  const [pin2, setPin2] = useState("");
  const [password, setPassword] = useState("");
  // First-time PIN: password (keyboard), then the new PIN twice on the pad.
  const [setupStage, setSetupStage] = useState<"password" | "new" | "confirm">("password");
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
        else
          setStep({
            kind: data.hasPin ? "pin" : "setup",
            stationName: data.stationName,
            username: data.username,
            otherStations: data.otherStations ?? [],
          });
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

  async function submitPin() {
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

  async function submitSetup() {
    if (step.kind !== "setup") return;
    if (!PIN_PATTERN.test(pin)) return setError("Your PIN has to be 4 to 6 numbers.");
    if (pin !== pin2) {
      setPin("");
      setPin2("");
      setSetupStage("new");
      return setError("The two PINs didn't match. Type your new PIN again.");
    }
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
        // A wrong password: back to that box. Anything else: try the PIN again.
        if (res.status === 401) {
          setPin("");
          setPin2("");
          setSetupStage("password");
        }
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
          <div className="flex flex-col gap-3">
            <div>
              <p id="station-signin-title" className="flex items-center gap-2 text-lg font-bold text-foreground">
                <Monitor className="size-5 text-primary" aria-hidden />
                Sign in at {step.stationName}
              </p>
              <p className="mt-0.5 text-sm text-muted-foreground">As {step.username}. Type your PIN.</p>
              <MovingNote from={step.otherStations} to={step.stationName} />
            </div>
            <PinPad
              value={pin}
              onChange={(v) => {
                setPin(v);
                setError(null);
              }}
              onSubmit={submitPin}
              submitLabel="Sign in"
              busy={busy}
            />
            {error && <p className="text-center text-sm font-medium text-danger">{error}</p>}
            <Button type="button" variant="ghost" block onClick={onClose}>
              Cancel
            </Button>
          </div>
        )}

        {step.kind === "setup" && (
          <div className="flex flex-col gap-3">
            <div>
              <p id="station-signin-title" className="text-lg font-bold text-foreground">
                {setupStage === "password" ? "Make your PIN" : setupStage === "new" ? "Pick your PIN" : "Same PIN again"}
              </p>
              <p className="mt-0.5 text-sm text-muted-foreground">
                {setupStage === "password"
                  ? `${step.username}: from now on you sign in at any station by scanning its screen and typing a PIN. Your password is needed just this once.`
                  : setupStage === "new"
                    ? "4 to 6 numbers you'll remember."
                    : "Type it once more to make sure."}
              </p>
              <MovingNote from={step.otherStations} to={step.stationName} />
            </div>
            {setupStage === "password" ? (
              <form
                className="flex flex-col gap-3"
                onSubmit={(e) => {
                  e.preventDefault();
                  if (!password) return;
                  setError(null);
                  setSetupStage("new");
                }}
              >
                <Field label="Your password">
                  <Input
                    type="password"
                    autoComplete="current-password"
                    autoFocus
                    value={password}
                    onChange={(e) => setPassword(e.target.value)}
                  />
                </Field>
                {error && <p className="text-sm font-medium text-danger">{error}</p>}
                <div className="flex gap-2">
                  <Button type="button" variant="outline" size="lg" onClick={onClose}>
                    Cancel
                  </Button>
                  <Button type="submit" size="lg" block disabled={!password}>
                    Next
                  </Button>
                </div>
              </form>
            ) : (
              <>
                {/* key: a fresh pad (and keyboard listener) for each stage. */}
                <PinPad
                  key={setupStage}
                  value={setupStage === "new" ? pin : pin2}
                  onChange={(v) => {
                    if (setupStage === "new") setPin(v);
                    else setPin2(v);
                    setError(null);
                  }}
                  onSubmit={() => {
                    if (setupStage === "new") setSetupStage("confirm");
                    else void submitSetup();
                  }}
                  submitLabel={setupStage === "new" ? "Next" : "Save"}
                  busy={busy}
                />
                {error && <p className="text-center text-sm font-medium text-danger">{error}</p>}
                <Button type="button" variant="ghost" block onClick={onClose}>
                  Cancel
                </Button>
              </>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
