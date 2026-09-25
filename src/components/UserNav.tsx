"use client";

import { useEffect, useState } from "react";

type CurrentUser = { id: string; username: string; role: "owner" | "employee" };

// Who's signed in, for role-dependent UI (AppShell hides owner-only nav
// links like Settings and Analyzer for an employee). Those routes are
// already hard-blocked server-side (proxy.ts) regardless, so hiding them
// here is about not dangling links that bounce, not the actual security
// boundary.
export function useCurrentUser() {
  const [user, setUser] = useState<CurrentUser | null>(null);
  useEffect(() => {
    fetch("/api/auth")
      .then((r) => (r.ok ? r.json() : null))
      .then(setUser)
      .catch(() => setUser(null));
  }, []);
  return user;
}

// A full page load rather than a client-side route change on purpose: it
// guarantees every bit of in-memory client state from the signed-out
// session is dropped.
export async function logout() {
  await fetch("/api/auth", { method: "DELETE" });
  window.location.href = "/login";
}
