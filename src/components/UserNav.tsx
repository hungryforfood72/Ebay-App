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
// session is dropped. A station PC set up for scanner sign-in goes back to
// its scan screen, ready for the next person.
export async function logout() {
  const res = await fetch("/api/auth", { method: "DELETE" });
  const data = await res.json().catch(() => null);
  window.location.href = data?.stationPc ? "/station-pc" : "/login";
}
