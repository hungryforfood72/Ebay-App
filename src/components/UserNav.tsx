"use client";

import Link from "next/link";
import { useEffect, useState } from "react";

type CurrentUser = { id: string; username: string; role: "owner" | "employee" };

// Small shared bit dropped into each page's own nav bar (every page here
// builds its nav inline rather than through a shared layout, so this is
// deliberately just "the user-specific piece," not a whole nav
// component) — shows who's signed in, a logout button, and the Settings
// link only for an owner. Settings is already hard-blocked server-side
// for an employee (proxy.ts) regardless of whether this link shows, so
// hiding it here is about not dangling a link that 403s, not the actual
// security boundary.
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

export function UserNavLinks({ showSettings = true }: { showSettings?: boolean }) {
  const user = useCurrentUser();

  async function logout() {
    await fetch("/api/auth", { method: "DELETE" });
    window.location.href = "/login";
  }

  return (
    <>
      {showSettings && user?.role === "owner" && (
        <Link href="/settings" className="text-sm underline">
          Settings
        </Link>
      )}
      {user && (
        <span className="flex items-center gap-2 text-sm text-gray-500">
          {user.username}
          <button type="button" onClick={logout} className="underline">
            Sign out
          </button>
        </span>
      )}
    </>
  );
}
