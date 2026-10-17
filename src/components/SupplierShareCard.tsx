"use client";

import { Button } from "@/components/ui/Button";
import { Card, SectionHeader } from "@/components/ui/Card";
import { Input } from "@/components/ui/Input";
import { Copy, ExternalLink, Link2, Link2Off, RefreshCw } from "lucide-react";
import { useState } from "react";

// Owner controls for the consignment supplier's read-only link (/s/{token},
// src/lib/supplierShare.ts). Replacing or turning it off kills the old link.
export function SupplierShareCard({
  manifestId,
  shareToken,
  onChange,
}: {
  manifestId: string;
  shareToken: string | null;
  onChange: () => void;
}) {
  const [saving, setSaving] = useState(false);
  const [copied, setCopied] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const url = shareToken && typeof window !== "undefined" ? `${window.location.origin}/s/${shareToken}` : null;

  async function send(method: "POST" | "DELETE") {
    if (method === "POST" && shareToken && !window.confirm("Make a new link? The current one will stop working.")) return;
    if (method === "DELETE" && !window.confirm("Turn the link off? He won't be able to open it anymore.")) return;
    setSaving(true);
    setError(null);
    try {
      const res = await fetch(`/api/manifests/${manifestId}/share`, { method });
      if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error ?? "Couldn't update the link.");
      setCopied(false);
      onChange();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Couldn't update the link.");
    } finally {
      setSaving(false);
    }
  }

  async function copy() {
    if (!url) return;
    try {
      await navigator.clipboard.writeText(url);
      setCopied(true);
    } catch {
      setError("Couldn't copy. Select the link and copy it by hand.");
    }
  }

  return (
    <Card>
      <SectionHeader
        title="Share with the supplier"
        description="A read-only page he can open without logging in: what you took, what's listed and sold, the profit, his share, your payments and what's still owed. It opens nothing else in the app."
      />
      {url ? (
        <div className="flex flex-col gap-3">
          <Input readOnly value={url} onFocus={(e) => e.target.select()} aria-label="Supplier link" />
          <div className="flex flex-wrap gap-2">
            <Button size="sm" onClick={copy}>
              <Copy className="size-4" aria-hidden />
              {copied ? "Copied" : "Copy link"}
            </Button>
            <a href={url} target="_blank" rel="noopener noreferrer">
              <Button size="sm" variant="outline">
                <ExternalLink className="size-4" aria-hidden />
                Open
              </Button>
            </a>
            <Button size="sm" variant="ghost" onClick={() => send("POST")} disabled={saving}>
              <RefreshCw className="size-4" aria-hidden />
              New link
            </Button>
            <Button size="sm" variant="ghost" onClick={() => send("DELETE")} disabled={saving}>
              <Link2Off className="size-4" aria-hidden />
              Turn off
            </Button>
          </div>
        </div>
      ) : (
        <Button size="sm" onClick={() => send("POST")} disabled={saving}>
          <Link2 className="size-4" aria-hidden />
          {saving ? "Creating…" : "Create link"}
        </Button>
      )}
      {error && <p className="mt-2 text-sm font-medium text-danger">{error}</p>}
    </Card>
  );
}
