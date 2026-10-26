"use client";

import { Button } from "@/components/ui/Button";
import { Card } from "@/components/ui/Card";
import { Field, Input } from "@/components/ui/Input";
import { Mail } from "lucide-react";
import Link from "next/link";
import { useState } from "react";

// "Forgot password?" from the sign-in page: emails a set-password link to
// the address on file (src/lib/passwordReset.ts).
export default function ForgotPasswordPage() {
  const [username, setUsername] = useState("");
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<{ ok: boolean; text: string } | null>(null);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setResult(null);
    try {
      const res = await fetch("/api/auth/forgot", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ username }),
      });
      const data = await res.json().catch(() => ({}));
      setResult(res.ok ? { ok: true, text: data.message } : { ok: false, text: data.error ?? "Couldn't send the email." });
    } catch {
      setResult({ ok: false, text: "Couldn't reach the app. Check your internet." });
    } finally {
      setBusy(false);
    }
  }

  return (
    <main className="mx-auto flex min-h-dvh w-full max-w-sm flex-col justify-center px-4 py-10">
      <div className="mb-8 flex flex-col items-center gap-3 text-center">
        <span className="grid size-14 place-items-center rounded-2xl bg-primary text-primary-foreground shadow-md">
          <Mail className="size-7" aria-hidden />
        </span>
        <div>
          <h1 className="text-2xl font-semibold tracking-tight text-foreground">Forgot your password?</h1>
          <p className="mt-1 text-sm text-muted-foreground">We&apos;ll email you a link to set a new one.</p>
        </div>
      </div>
      <Card className="p-5 sm:p-6">
        {result?.ok ? (
          <p className="text-base text-foreground">{result.text}</p>
        ) : (
          <form onSubmit={submit} className="flex flex-col gap-4">
            <Field label="Username">
              <Input
                type="text"
                autoFocus
                autoComplete="username"
                autoCapitalize="off"
                value={username}
                onChange={(e) => setUsername(e.target.value)}
              />
            </Field>
            {result && <p className="text-sm font-medium text-danger">{result.text}</p>}
            <Button type="submit" size="lg" block disabled={busy || !username.trim()}>
              {busy ? "Sending…" : "Email me a link"}
            </Button>
          </form>
        )}
      </Card>
      <Link href="/login" className="mt-6 text-center text-sm text-muted-foreground underline">
        Back to sign in
      </Link>
    </main>
  );
}
