"use client";

import { Button } from "@/components/ui/Button";
import { Card } from "@/components/ui/Card";
import { Field, Input } from "@/components/ui/Input";
import { KeyRound } from "lucide-react";
import Link from "next/link";
import { useParams } from "next/navigation";
import { useEffect, useState } from "react";

// Where a set-your-password email link lands (src/lib/passwordReset.ts).
// Reachable signed out: everything under /login is (proxy.ts).
const MIN_LENGTH = 8;

export default function SetPasswordPage() {
  const { token } = useParams<{ token: string }>();
  const [username, setUsername] = useState<string | null>(null);
  const [linkError, setLinkError] = useState<string | null>(null);
  const [password, setPassword] = useState("");
  const [password2, setPassword2] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    fetch(`/api/auth/reset?token=${encodeURIComponent(token)}`, { cache: "no-store" })
      .then(async (r) => {
        const data = await r.json().catch(() => ({}));
        if (r.ok) setUsername(data.username);
        else setLinkError(data.error ?? "This link doesn't work.");
      })
      .catch(() => setLinkError("Couldn't reach the app. Check your internet and reload."));
  }, [token]);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (password.length < MIN_LENGTH) return setError(`Use at least ${MIN_LENGTH} characters.`);
    if (password !== password2) return setError("The two passwords don't match.");
    setBusy(true);
    setError(null);
    try {
      const res = await fetch("/api/auth/reset", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ token, password }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error ?? "Couldn't save your password.");
      // Signed in now: a full load so the app starts fresh as them.
      window.location.replace("/");
    } catch (e) {
      setError(e instanceof Error ? e.message : "Couldn't save your password.");
      setBusy(false);
    }
  }

  return (
    <main className="mx-auto flex min-h-dvh w-full max-w-sm flex-col justify-center px-4 py-10">
      <div className="mb-8 flex flex-col items-center gap-3 text-center">
        <span className="grid size-14 place-items-center rounded-2xl bg-primary text-primary-foreground shadow-md">
          <KeyRound className="size-7" aria-hidden />
        </span>
        <h1 className="text-2xl font-semibold tracking-tight text-foreground">Set your password</h1>
      </div>
      <Card className="p-5 sm:p-6">
        {linkError ? (
          <div className="flex flex-col gap-3 text-center">
            <p className="text-base text-foreground">{linkError}</p>
            <Link href="/login/forgot" className="font-medium text-primary underline">
              Send me a new link
            </Link>
          </div>
        ) : !username ? (
          <p className="text-center text-sm text-muted-foreground">Checking your link…</p>
        ) : (
          <form onSubmit={submit} className="flex flex-col gap-4">
            <p className="text-sm text-muted-foreground">
              Your username is <span className="font-semibold text-foreground">{username}</span>. Pick a password you&apos;ll
              remember, at least {MIN_LENGTH} characters.
            </p>
            {/* For password managers: which account this password is for. */}
            <input type="text" autoComplete="username" value={username} readOnly hidden />
            <Field label="New password">
              <Input type="password" autoComplete="new-password" autoFocus value={password} onChange={(e) => setPassword(e.target.value)} />
            </Field>
            <Field label="Same password again">
              <Input type="password" autoComplete="new-password" value={password2} onChange={(e) => setPassword2(e.target.value)} />
            </Field>
            {error && <p className="text-sm font-medium text-danger">{error}</p>}
            <Button type="submit" size="lg" block disabled={busy || !password || !password2}>
              {busy ? "Saving…" : "Save and sign in"}
            </Button>
          </form>
        )}
      </Card>
    </main>
  );
}
