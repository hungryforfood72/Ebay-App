"use client";

import { ScanField } from "@/components/ScanField";
import { AppShell } from "@/components/ui/AppShell";
import { Button } from "@/components/ui/Button";
import { Card, SectionHeader } from "@/components/ui/Card";
import { Field, Input } from "@/components/ui/Input";
import { PIN_PATTERN } from "@/lib/stationSignInCode";
import { useEffect, useState } from "react";

// Station sign-in from the handheld (src/lib/stationSignIn.ts): scan a
// station PC's sign-in screen here (any scan box in the app works too),
// and make or change your PIN. In the menu under your name.
export default function PinPage() {
  const [scan, setScan] = useState("");
  const [scanNote, setScanNote] = useState<string | null>(null);
  const [hasPin, setHasPin] = useState<boolean | null>(null);
  const [password, setPassword] = useState("");
  const [pin, setPin] = useState("");
  const [pin2, setPin2] = useState("");
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{ ok: boolean; text: string } | null>(null);

  useEffect(() => {
    fetch("/api/station-signin/pin")
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => setHasPin(d?.hasPin ?? false))
      .catch(() => setHasPin(false));
  }, []);

  async function savePin(e: React.FormEvent) {
    e.preventDefault();
    if (!PIN_PATTERN.test(pin)) return setMessage({ ok: false, text: "Your PIN has to be 4 to 6 numbers." });
    if (pin !== pin2) return setMessage({ ok: false, text: "The two PINs don't match." });
    setBusy(true);
    setMessage(null);
    try {
      const res = await fetch("/api/station-signin/pin", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ password, pin }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error ?? "Couldn't save your PIN.");
      setHasPin(true);
      setPassword("");
      setPin("");
      setPin2("");
      setMessage({ ok: true, text: "PIN saved." });
    } catch (e) {
      setMessage({ ok: false, text: e instanceof Error ? e.message : "Couldn't save your PIN." });
    } finally {
      setBusy(false);
    }
  }

  return (
    <AppShell width="narrow" title="Station sign-in" subtitle="Sign in at a station PC with this scanner and your PIN.">
      <div className="flex flex-col gap-4">
        <Card>
          <SectionHeader
            title="Sign in at a station"
            description="On the station PC, Log out (or find it already showing a QR code). Scan that code, then type your PIN here."
          />
          <ScanField
            id="station-signin-scan"
            label="Station code"
            prompt="Scan the code on the station screen"
            value={scan}
            autoFocus
            onChange={(v) => {
              setScan(v);
              setScanNote(null);
            }}
            onScan={() => setScanNote("That's not a station sign-in code. Scan the QR code on the station PC's screen.")}
          />
          {scanNote && <p className="mt-2 text-sm font-medium text-danger">{scanNote}</p>}
        </Card>

        <Card>
          <SectionHeader
            title={hasPin ? "Change your PIN" : "Make your PIN"}
            description={
              hasPin === null
                ? "Loading…"
                : hasPin
                  ? "You have a PIN. Forgot it? Make a new one here with your password."
                  : "You don't have a PIN yet. You can also make it the first time you scan a station."
            }
          />
          <form onSubmit={savePin} className="flex flex-col gap-3">
            <Field label="Your password">
              <Input type="password" autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} />
            </Field>
            <Field label="New PIN" hint="4 to 6 numbers.">
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
            {message && <p className={message.ok ? "text-sm font-medium text-success" : "text-sm font-medium text-danger"}>{message.text}</p>}
            <Button type="submit" size="lg" block disabled={busy || !password || !pin || !pin2}>
              {busy ? "Saving…" : "Save PIN"}
            </Button>
          </form>
        </Card>
      </div>
    </AppShell>
  );
}
