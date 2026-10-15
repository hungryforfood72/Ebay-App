"use client";

import { Button } from "@/components/ui/Button";
import { Field, Select, Textarea } from "@/components/ui/Input";
import { MAX_RECOMMENDED_PACK, splitIntoPacks } from "@/lib/packSize";
import { Boxes, LoaderCircle, PackageMinus } from "lucide-react";
import { useEffect, useState } from "react";

type PackPlanGroup = { packSize: number; listings: number };

type PackSuggestion = {
  isOwner: boolean;
  alreadyMultipack: boolean;
  manifestPackSize: number;
  available: number | null;
  // available came from a count typed on the card; manifestLeft is what
  // the manifest said (null off a manifest).
  countedByHand?: boolean;
  manifestLeft?: number | null;
  // Set when the count came from a load other than the one being scanned
  // into (or none was picked): that load's title.
  manifestTitle: string | null;
  // Every unit the manifest listed is already scanned in; `available` is
  // then 1, for the one in hand.
  alreadyScannedIn: boolean;
  expected: number | null;
  plan: PackPlanGroup[] | null;
  // Units not worth listing at the size they'd have to go in (see
  // /api/pack-suggestion). units is null off a manifest, where it's a
  // heads-up about a single. Dollar figures owner only.
  setAside: {
    units: number | null;
    packSize: number;
    // "slow_single": a lone single of something meant for multi-packs.
    // "low_return": wouldn't make Cristian's target profit on its cost.
    why: "slow_single" | "low_return";
    // No pack size up to the max makes Cristian's target on eBay, so the
    // whole lot is set aside, and shopPlan is how it'd split for
    // Shopify & Whatnot instead (null off a manifest).
    everything?: boolean;
    shopPlan?: PackPlanGroup[] | null;
    price?: number;
    label?: number;
    itemCost?: number | null;
    profit?: number;
    returnPct?: number | null;
    targetReturnPct?: number | null;
    requiredProfit?: number;
    // Sold on Shopify/Whatnot instead, where the buyer pays the label. Only
    // there once the store is connected. worthIt null: no eBay listings to
    // price it from. Dollar figures owner only.
    shopChannel?: { worthIt: boolean | null; price?: number | null; profit?: number | null } | null;
  } | null;
  recommendation: {
    packSize: number;
    // "agent": the pack-size agent's call (src/lib/packAdvisor.ts), with a
    // reason. The others are the formula fallback, with no reason.
    basis: "agent" | "listings" | "estimate";
    reason: string | null;
    compCount: number;
    // Owner only — absent for an employee, null when nobody lists that
    // pack size yet.
    perPackPrice?: number | null;
    netPerUnit?: number | null;
    singleNetPerUnit?: number | null;
  } | null;
};

const packLabel = (size: number) => (size > 1 ? `${size}-pack` : "single");
const listingsOf = (g: PackPlanGroup) =>
  g.listings === 1
    ? g.packSize > 1
      ? `1 listing of a ${g.packSize}-pack`
      : "1 single"
    : `${g.listings} listings of ${g.packSize > 1 ? `${g.packSize}-packs` : "singles"}`;
const money = (n: number) => `$${n.toFixed(2)}`;
const manifestLabel = (d: { manifestTitle: string | null }) =>
  d.manifestTitle ? `the "${d.manifestTitle}" manifest` : "this manifest";
// "5 on hand:" for a typed count, "3 left on this manifest:" otherwise.
const countLabel = (d: PackSuggestion) =>
  d.countedByHand
    ? `You have ${d.available}${d.manifestLeft != null ? ` (the manifest said ${d.manifestLeft} left)` : ""}`
    : `${d.available} left on ${manifestLabel(d)}`;

// On the scan page's quantity step: what pack size this UPC sells best in
// (from live eBay listings, see /api/pack-suggestion) and, on a manifest,
// how to split what's left of it. "Fill in" sets the pack size and quantity
// for the first group; after saving, scanning the same UPC again shows the
// plan for whatever's still left.
export function PackSuggestionCard({
  upc,
  manifestId,
  onApply,
  onSetAside,
  onShopifyOnly,
}: {
  upc: string;
  manifestId: string | null;
  onApply: (packSize: number, listings: number | null) => void;
  // Skip this item without saving it, straight to the next scan.
  onSetAside: () => void;
  // Keep scanning it in, but for Shopify & Whatnot only (no eBay listing).
  onShopifyOnly: (packSize: number, listings: number | null) => void;
}) {
  const baseKey = `${upc}|${manifestId ?? ""}`;
  // A count Lizvet typed in, for this UPC only: a new scan starts over
  // from the manifest's count.
  const [have, setHave] = useState<{ key: string; count: number } | null>(null);
  const haveCount = have?.key === baseKey ? have.count : null;
  const key = `${baseKey}|${haveCount ?? ""}`;
  const [result, setResult] = useState<{ key: string; data: PackSuggestion | null } | null>(null);
  const loading = result?.key !== key;
  const changeCount = (count: number | null) => setHave(count == null ? null : { key: baseKey, count });

  useEffect(() => {
    const params = new URLSearchParams({ upc });
    if (manifestId) params.set("manifestId", manifestId);
    if (haveCount != null) params.set("have", String(haveCount));
    let cancelled = false;
    fetch(`/api/pack-suggestion?${params}`)
      .then((r) => (r.ok ? r.json() : null))
      .catch(() => null)
      .then((data: PackSuggestion | null) => !cancelled && setResult({ key, data }));
    return () => {
      cancelled = true;
    };
  }, [upc, manifestId, key, haveCount]);

  if (loading) {
    return (
      <div className="flex items-center gap-2 rounded-xl border border-border bg-background p-3 text-sm text-muted-foreground">
        <LoaderCircle className="size-4 animate-spin" aria-hidden />
        Working out the best pack size…
      </div>
    );
  }

  const data = result?.data;
  const rec = data?.recommendation;
  if (data?.alreadyMultipack) return <AlreadyMultipackCard data={data} onApply={onApply} onChangeCount={changeCount} />;
  if (!data || !rec) return null;

  const first = data.plan?.[0] ?? null;
  const rest = data.plan?.slice(1) ?? [];
  // Offered when everything in hand is a set-aside and the store makes it
  // worth selling (or there are no comps to tell either way).
  const allAside = Boolean(data.setAside) && (!data.plan || data.plan.length === 0);
  const shopChannel = data.setAside?.shopChannel ?? null;
  const offerShop = allAside && shopChannel != null && shopChannel.worthIt !== false;
  const notForEbay = Boolean(data.setAside?.everything);
  const shopFirst = data.setAside?.shopPlan?.[0] ?? null;
  const shopRest = data.setAside?.shopPlan?.slice(1) ?? [];

  return (
    <div className="rounded-xl border border-blue-200 bg-blue-50 p-4 text-sm text-blue-950">
      <div className="flex gap-2">
        <Boxes className="mt-0.5 size-5 shrink-0 text-primary" aria-hidden />
        <div className="min-w-0">
          <p className="font-semibold">
            {notForEbay
              ? "Not worth listing on eBay"
              : `Suggested: sell as ${rec.packSize > 1 ? `${rec.packSize}-packs` : "singles"}`}
          </p>
          <p className="mt-0.5 text-blue-900/80">
            {notForEbay
              ? `Shipping eats the whole sale: even bundled up to ${MAX_RECOMMENDED_PACK}-packs, or as one lot, it wouldn't make enough profit on eBay after fees and a label.`
              : rec.reason
              ? rec.reason
              : rec.basis === "estimate"
                ? `Only singles are listed on eBay, and shipping eats most of a single's price, so a ${packLabel(rec.packSize)} should earn more per item.`
                : `Based on ${rec.compCount} eBay listing${rec.compCount === 1 ? "" : "s"} of ${rec.packSize > 1 ? `${rec.packSize}-packs` : "singles"}.`}
            {!notForEbay && rec.perPackPrice != null && rec.netPerUnit != null && (
              <>
                {" "}
                About {money(rec.perPackPrice)} per {packLabel(rec.packSize)}, {money(rec.netPerUnit)} per item after
                fees and shipping
                {rec.packSize > 1 && rec.singleNetPerUnit != null && <> vs {money(rec.singleNetPerUnit)} as singles</>}.
              </>
            )}
          </p>

          {data.plan && data.available != null && (data.plan.length > 0 || data.setAside) && (
            <p className="mt-2">
              <span className="font-medium">
                {data.alreadyScannedIn
                  ? `All ${data.expected ?? ""} on ${manifestLabel(data)} ${data.expected === 1 ? "is" : "are"} already scanned in, so this one looks extra. For this one:`
                  : `${countLabel(data)}:`}
              </span>{" "}
              {[
                ...data.plan.map(listingsOf),
                ...(data.setAside?.units ? [`${data.setAside.units} to set aside`] : []),
              ].join(" + ")}
              .
            </p>
          )}

          {data.setAside && <SetAsideNote setAside={data.setAside} recommendedPackSize={rec.packSize} />}
          {notForEbay && offerShop && shopRest.length > 0 && (
            <p className="mt-2 text-xs text-blue-900/80">
              For Shopify &amp; Whatnot: {[shopFirst, ...shopRest].filter(Boolean).map((g) => listingsOf(g!)).join(" + ")}.
              Fill in the first, then save and scan it again for the rest.
            </p>
          )}

          <div className="mt-3 flex flex-wrap items-center gap-2">
            {allAside && offerShop && data.setAside ? (
              <>
                <Button
                  size="sm"
                  onClick={() => {
                    const aside = data.setAside!;
                    if (shopFirst) onShopifyOnly(shopFirst.packSize, shopFirst.listings);
                    else onShopifyOnly(aside.packSize, aside.units != null ? Math.max(1, Math.round(aside.units / aside.packSize)) : null);
                  }}
                >
                  Sell on Shopify &amp; Whatnot instead
                </Button>
                <Button size="sm" variant="outline" onClick={onSetAside}>
                  Set aside anyway
                </Button>
              </>
            ) : data.plan && data.plan.length === 0 && data.setAside ? (
              <Button size="sm" variant="outline" onClick={onSetAside}>
                Set aside, scan the next item
              </Button>
            ) : first ? (
              <Button size="sm" onClick={() => onApply(first.packSize, first.listings)}>
                Fill in {listingsOf(first)}
              </Button>
            ) : (
              <Button size="sm" onClick={() => onApply(rec.packSize, null)}>
                Fill in {packLabel(rec.packSize)}
              </Button>
            )}
            {rest.length > 0 && (
              <span className="text-xs text-blue-900/80">
                Then save and scan it again for the {rest.map(listingsOf).join(" + ")}.
              </span>
            )}
          </div>

          <CountOverride key={key} data={data} onChange={changeCount} />

          {data.isOwner && (
            <TeachAgent
              key={key}
              upc={upc}
              manifestId={manifestId}
              suggestedPackSize={rec.packSize}
              onSaved={(size) => {
                const firstGroup = data.available != null && data.available > 0 ? splitIntoPacks(data.available, size)[0] : null;
                onApply(firstGroup?.packSize ?? size, firstGroup?.listings ?? null);
              }}
            />
          )}
        </div>
      </div>
    </div>
  );
}

// The manifest's unit is already a store multi-pack (a "2-pk." twin pack):
// each one is listed as it came, never split up or bundled with others,
// so Lizvet doesn't mistake the manifest count for loose singles.
function AlreadyMultipackCard({
  data,
  onApply,
  onChangeCount,
}: {
  data: PackSuggestion;
  onApply: (packSize: number, listings: number | null) => void;
  onChangeCount: (count: number | null) => void;
}) {
  const n = data.manifestPackSize;
  const left = data.available;
  return (
    <div className="rounded-xl border border-blue-200 bg-blue-50 p-4 text-sm text-blue-950">
      <div className="flex gap-2">
        <Boxes className="mt-0.5 size-5 shrink-0 text-primary" aria-hidden />
        <div className="min-w-0">
          <p className="font-semibold">Already a {n}-pack from the store: list it as is</p>
          <p className="mt-0.5 text-blue-900/80">
            Each one you&apos;re holding is a sealed {n}-pack. Don&apos;t split it up or bundle several together, one
            {" "}{n}-pack per sale.
          </p>
          {left != null && (
            <p className="mt-2">
              <span className="font-medium">
                {data.alreadyScannedIn
                  ? `All ${data.expected ?? ""} on ${manifestLabel(data)} ${data.expected === 1 ? "is" : "are"} already scanned in, so this one looks extra.`
                  : data.countedByHand
                    ? `You have ${left} ${n}-pack${left === 1 ? "" : "s"}${data.manifestLeft != null ? ` (the manifest said ${data.manifestLeft} left)` : ""}.`
                    : `${left} ${n}-pack${left === 1 ? "" : "s"} left on ${manifestLabel(data)}.`}
              </span>
            </p>
          )}
          <div className="mt-3">
            <Button size="sm" onClick={() => onApply(1, left)}>
              Fill in {left != null && left > 1 ? `quantity ${left}, ` : ""}one {n}-pack each
            </Button>
          </div>
          <CountOverride data={data} onChange={onChangeCount} />
        </div>
      </div>
    </div>
  );
}

// The manifest's count is often off (extras, shortages, a case split
// across boxes). Lizvet types how many she's actually holding and the plan
// is worked out again for that number.
function CountOverride({ data, onChange }: { data: PackSuggestion; onChange: (count: number | null) => void }) {
  const [open, setOpen] = useState(false);
  const [value, setValue] = useState(data.available != null ? String(data.available) : "");
  const count = Number(value);
  const valid = Number.isInteger(count) && count > 0 && count <= 1000;

  if (!open) {
    return (
      <div className="mt-3 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs">
        <button type="button" className="font-medium text-primary underline" onClick={() => setOpen(true)}>
          Have a different amount?
        </button>
        {data.countedByHand && (
          <button type="button" className="text-blue-900/80 underline" onClick={() => onChange(null)}>
            Use the manifest&apos;s count
          </button>
        )}
      </div>
    );
  }
  return (
    <form
      className="mt-3 flex flex-wrap items-end gap-2"
      onSubmit={(e) => {
        e.preventDefault();
        if (valid) onChange(count);
      }}
    >
      <label className="flex flex-col gap-1 text-xs font-medium">
        How many do you have?
        <input
          type="number"
          inputMode="numeric"
          min={1}
          max={1000}
          autoFocus
          value={value}
          onChange={(e) => setValue(e.target.value)}
          className="h-10 w-24 rounded-lg border border-border bg-background px-3 text-base text-foreground"
        />
      </label>
      <Button size="sm" type="submit" disabled={!valid}>
        Update
      </Button>
      <Button size="sm" variant="outline" type="button" onClick={() => setOpen(false)}>
        Cancel
      </Button>
    </form>
  );
}

// Units not worth listing at the only size they can go in (see
// /api/pack-suggestion) — Lizvet sets them aside and moves on; Cristian
// decides what happens to them later.
function SetAsideNote({
  setAside,
  recommendedPackSize,
}: {
  setAside: NonNullable<PackSuggestion["setAside"]>;
  recommendedPackSize: number;
}) {
  const n = setAside.units;
  const title =
    n == null
      ? setAside.everything
        ? "Set these aside."
        : recommendedPackSize > 1
        ? `If you have fewer than ${recommendedPackSize}, set them aside.`
        : "Set this aside."
      : n === 1
        ? "Set this one aside."
        : `Set these ${n} aside.`;
  const what = setAside.packSize > 1 ? `a ${setAside.packSize}-pack` : "a single";
  const why =
    setAside.why === "slow_single"
      ? `Singles of this don't sell well on their own, it's meant to go out as ${recommendedPackSize}-packs.`
      : setAside.everything
        ? `Even as ${what} it wouldn't make enough profit after shipping and fees.`
        : `As ${what} it wouldn't make enough profit after shipping and fees.`;
  return (
    <div className="mt-3 flex gap-2 rounded-lg border border-amber-200 bg-amber-50 p-3 text-amber-950">
      <PackageMinus className="mt-0.5 size-5 shrink-0 text-amber-600" aria-hidden />
      <div className="min-w-0">
        <p className="font-semibold">{title}</p>
        <p className="mt-0.5 text-amber-900/80">
          {why} Don&apos;t list {n === 1 || n == null ? "it" : "them"}, just set {n === 1 || n == null ? "it" : "them"}{" "}
          aside and move on to the next item.
        </p>
        {setAside.price != null && setAside.label != null && setAside.profit != null && (
          <p className="mt-1.5 text-xs text-amber-900/70">
            As {what}: sells for about {money(setAside.price)}, minus ~{money(setAside.label)} shipping, fees
            {setAside.itemCost != null ? <> and {money(setAside.itemCost)} item cost</> : null} ={" "}
            {setAside.profit < 0 ? `a ${money(-setAside.profit)} loss` : `${money(setAside.profit)} profit`}
            {setAside.requiredProfit != null && (
              <>
                {" "}
                (needs {money(setAside.requiredProfit)}:{" "}
                {setAside.itemCost == null
                  ? "the $1.50 minimum, no landed cost entered for this load yet"
                  : `${setAside.targetReturnPct}% on cost, at least $1.50`}
                )
              </>
            )}
            .
          </p>
        )}
        {setAside.shopChannel && <ShopChannelLine shop={setAside.shopChannel} what={what} />}
      </div>
    </div>
  );
}

// What happens if it goes to Shopify & Whatnot instead of the shelf.
function ShopChannelLine({
  shop,
  what,
}: {
  shop: NonNullable<NonNullable<PackSuggestion["setAside"]>["shopChannel"]>;
  what: string;
}) {
  if (shop.worthIt === null) {
    return (
      <p className="mt-1.5 text-xs text-amber-900/80">
        No eBay listings to price it from. It can still go to Shopify &amp; Whatnot, priced by hand in review.
      </p>
    );
  }
  const numbers =
    shop.price != null && shop.profit != null
      ? ` As ${what} there: about ${money(shop.price)}, ${shop.profit < 0 ? `a ${money(-shop.profit)} loss` : `${money(shop.profit)} profit`} after Whatnot-level fees.`
      : "";
  return shop.worthIt ? (
    <p className="mt-1.5 font-medium text-amber-950">
      On Shopify &amp; Whatnot the buyer pays shipping, so it&apos;s worth selling there.{numbers}
    </p>
  ) : (
    <p className="mt-1.5 text-xs text-amber-900/80">
      Too thin even on Shopify &amp; Whatnot.{numbers} Set it aside for a Whatnot live bundle.
    </p>
  );
}

// Owner only: tell the agent it's wrong and why. Saved as a PackFeedback
// lesson (see /api/pack-feedback) and also fills in the chosen pack size.
function TeachAgent({
  upc,
  manifestId,
  suggestedPackSize,
  onSaved,
}: {
  upc: string;
  manifestId: string | null;
  suggestedPackSize: number;
  onSaved: (packSize: number) => void;
}) {
  const [open, setOpen] = useState(false);
  const [chosen, setChosen] = useState(String(suggestedPackSize === 1 ? 2 : 1));
  const [reason, setReason] = useState("");
  const [saving, setSaving] = useState(false);
  const [status, setStatus] = useState<{ ok: boolean; text: string } | null>(null);

  if (status?.ok) return <p className="mt-3 text-xs text-blue-900/80">{status.text}</p>;

  if (!open) {
    return (
      <button type="button" className="mt-3 text-xs font-medium text-primary underline" onClick={() => setOpen(true)}>
        Disagree? Teach it
      </button>
    );
  }

  async function save() {
    if (!reason.trim()) return setStatus({ ok: false, text: "Say why, so it can learn from it." });
    setSaving(true);
    setStatus(null);
    try {
      const res = await fetch("/api/pack-feedback", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ upc, manifestId, suggestedPackSize, chosenPackSize: Number(chosen), reason: reason.trim() }),
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        throw new Error(err.error ?? "Couldn't save that.");
      }
      onSaved(Number(chosen));
      setStatus({ ok: true, text: "Got it. The agent will use this on the next items it decides." });
    } catch (e) {
      setStatus({ ok: false, text: e instanceof Error ? e.message : "Couldn't save that." });
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="mt-3 flex flex-col gap-3 rounded-lg border border-blue-200 bg-white p-3 text-foreground">
      <Field label="How should it be sold?">
        <Select value={chosen} onChange={(e) => setChosen(e.target.value)}>
          {Array.from({ length: MAX_RECOMMENDED_PACK }, (_, i) => i + 1).map((n) => (
            <option key={n} value={n}>
              {n > 1 ? `${n}-packs` : "Singles"}
            </option>
          ))}
        </Select>
      </Field>
      <Field label="Why?" hint="The agent learns from your reasoning, so a sentence or two helps more than just the answer.">
        <Textarea
          rows={3}
          value={reason}
          onChange={(e) => setReason(e.target.value)}
          placeholder="e.g. Buyers can get this at the store for less, the 3-packs are what actually sell."
        />
      </Field>
      {status && !status.ok && <p className="text-xs text-danger">{status.text}</p>}
      <div className="flex gap-2">
        <Button size="sm" onClick={save} disabled={saving}>
          {saving ? "Saving…" : "Save and fill in"}
        </Button>
        <Button size="sm" variant="ghost" onClick={() => setOpen(false)} disabled={saving}>
          Cancel
        </Button>
      </div>
    </div>
  );
}
