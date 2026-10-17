"use client";

import { AppShell } from "@/components/ui/AppShell";
import { Badge } from "@/components/ui/Badge";
import { Card } from "@/components/ui/Card";
import { useCurrentUser } from "@/components/UserNav";
import type { StationStatus } from "@/lib/warehouse/types";
import { ChevronRight, Monitor } from "lucide-react";
import Link from "next/link";
import { useEffect, useState } from "react";

// Pick which station this computer is. The page you land on is the one to
// leave open on the station PC (scale + label printer).
export default function StationsPage() {
  const user = useCurrentUser();
  const [stations, setStations] = useState<StationStatus[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    fetch("/api/stations")
      .then(async (r) => {
        const data = await r.json();
        if (!r.ok) throw new Error(data.error ?? "Couldn't load stations.");
        setStations(data as StationStatus[]);
      })
      .catch((e) => setError(e instanceof Error ? e.message : "Couldn't load stations."));
  }, []);

  return (
    <AppShell
      width="narrow"
      title="Stations"
      subtitle="Open your station on the PC with the scale and label printer, and leave it open."
    >
      {error && <p className="mb-3 text-sm font-medium text-danger">{error}</p>}
      {!stations ? (
        !error && <p className="text-sm text-muted-foreground">Loading…</p>
      ) : stations.length === 0 ? (
        <Card>
          <p className="text-sm text-muted-foreground">
            No stations yet.{" "}
            {user?.role === "owner" ? (
              <>
                Add one in{" "}
                <Link href="/settings#warehouse" className="font-medium text-primary underline">
                  Settings
                </Link>
                .
              </>
            ) : (
              "Ask the owner to add one in Settings."
            )}
          </p>
        </Card>
      ) : (
        <ul className="flex flex-col gap-2">
          {stations.map((s) => (
            <li key={s.id}>
              <Link
                href={`/station/${s.id}`}
                className="flex items-center gap-3 rounded-xl border border-border bg-surface p-4 shadow-sm transition-colors hover:bg-muted"
              >
                <span className="grid size-10 shrink-0 place-items-center rounded-lg bg-muted text-foreground">
                  <Monitor className="size-5" aria-hidden />
                </span>
                <span className="min-w-0 flex-1">
                  <span className="block truncate font-medium text-foreground">{s.name}</span>
                  <span className="mt-0.5 block text-xs text-muted-foreground">
                    {s.online ? "Open on a PC right now" : "Not open anywhere"}
                  </span>
                </span>
                <Badge tone={s.online ? "success" : "neutral"}>{s.online ? "Online" : "Offline"}</Badge>
                <ChevronRight className="size-4 text-muted-foreground" aria-hidden />
              </Link>
            </li>
          ))}
        </ul>
      )}
    </AppShell>
  );
}
