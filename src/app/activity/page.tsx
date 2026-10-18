"use client";

import { AppShell } from "@/components/ui/AppShell";
import { Badge, type BadgeTone } from "@/components/ui/Badge";
import { Button } from "@/components/ui/Button";
import { Card } from "@/components/ui/Card";
import { Input, Select } from "@/components/ui/Input";
import { useCallback, useEffect, useState } from "react";

// The activity log (src/lib/activityLog.ts): who did what, newest first.
// "Important only" leaves out the raw request rows and keeps the named
// changes (prices, edits, deletes, settings, sign-ins).

type Row = {
  id: string;
  at: string;
  username: string | null;
  role: string | null;
  action: string;
  targetType: string | null;
  targetId: string | null;
  summary: string;
  before: unknown;
  after: unknown;
  ip: string | null;
};

function tone(action: string): BadgeTone {
  if (action === "request") return "neutral";
  if (action.endsWith("delete") || action === "auth.login_failed") return "danger";
  if (action.startsWith("auth")) return "purple";
  if (action === "setting") return "warning";
  return "primary";
}

export default function ActivityPage() {
  const [rows, setRows] = useState<Row[]>([]);
  const [users, setUsers] = useState<string[]>([]);
  const [more, setMore] = useState(false);
  const [user, setUser] = useState("");
  const [q, setQ] = useState("");
  const [important, setImportant] = useState(true);
  const [open, setOpen] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  const load = useCallback(
    async (before?: string) => {
      setLoading(true);
      try {
        const params = new URLSearchParams();
        if (user) params.set("user", user);
        if (q.trim()) params.set("q", q.trim());
        if (important) params.set("important", "1");
        if (before) params.set("before", before);
        const res = await fetch(`/api/activity?${params}`);
        const json = await res.json();
        if (!res.ok) return;
        setRows((prev) => (before ? [...prev, ...json.rows] : json.rows));
        setUsers(json.users);
        setMore(json.more);
      } finally {
        setLoading(false);
      }
    },
    [user, q, important]
  );

  useEffect(() => {
    // Reload when the user or "important only" filter changes; the search
    // box reloads on submit.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [user, important]);

  return (
    <AppShell title="Activity log" subtitle="Who did what in the app, newest first" width="wide">
      <div className="mb-4 flex flex-wrap items-center gap-3">
        <Select value={user} onChange={(e) => setUser(e.target.value)} className="w-40">
          <option value="">Everyone</option>
          {users.map((u) => (
            <option key={u} value={u}>
              {u}
            </option>
          ))}
        </Select>
        <form
          className="flex min-w-0 flex-1 gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            load();
          }}
        >
          <Input placeholder="Search (item title, ES code, setting...)" value={q} onChange={(e) => setQ(e.target.value)} />
          <Button type="submit" variant="outline">
            Search
          </Button>
        </form>
        <label className="flex items-center gap-2 text-sm text-foreground">
          <input type="checkbox" className="size-4" checked={important} onChange={(e) => setImportant(e.target.checked)} />
          Important only
        </label>
      </div>
      <Card padded={false} className="divide-y divide-border">
        {rows.length === 0 && <p className="p-4 text-sm text-muted-foreground">{loading ? "Loading…" : "Nothing logged yet."}</p>}
        {rows.map((r) => (
          <div key={r.id} className="p-3">
            <button
              type="button"
              className="flex w-full flex-wrap items-baseline gap-x-3 gap-y-1 text-left"
              onClick={() => setOpen(open === r.id ? null : r.id)}
            >
              <span className="w-36 shrink-0 text-xs text-muted-foreground">
                {new Date(r.at).toLocaleString([], { month: "short", day: "numeric", hour: "numeric", minute: "2-digit", second: "2-digit" })}
              </span>
              <span className="w-24 shrink-0 text-sm font-medium text-foreground">{r.username ?? "(no one)"}</span>
              <Badge tone={tone(r.action)}>{r.action}</Badge>
              <span className="min-w-0 flex-1 text-sm text-foreground">{r.summary}</span>
            </button>
            {open === r.id && (
              <div className="mt-2 grid gap-2 text-xs md:grid-cols-2">
                {r.before != null && (
                  <pre className="overflow-x-auto rounded-lg bg-muted p-2">
                    <b>Before</b>
                    {"\n"}
                    {JSON.stringify(r.before, null, 2)}
                  </pre>
                )}
                {r.after != null && (
                  <pre className="overflow-x-auto rounded-lg bg-muted p-2">
                    <b>{r.action === "request" ? "Sent" : "After"}</b>
                    {"\n"}
                    {JSON.stringify(r.after, null, 2)}
                  </pre>
                )}
                <p className="text-muted-foreground md:col-span-2">
                  {[r.targetType && `${r.targetType} ${r.targetId}`, r.ip && `IP ${r.ip}`].filter(Boolean).join(" · ")}
                </p>
              </div>
            )}
          </div>
        ))}
      </Card>
      {more && (
        <div className="mt-4 flex justify-center">
          <Button variant="outline" onClick={() => load(rows[rows.length - 1]?.at)} disabled={loading}>
            {loading ? "Loading…" : "Older"}
          </Button>
        </div>
      )}
    </AppShell>
  );
}
