"use client";

import { ScanField } from "@/components/ScanField";
import { ScanStationCard, StationOnline, useChosenStation } from "@/components/StationPicker";
import { StationSignOutButton } from "@/components/StationSignIn";
import { useCurrentUser } from "@/components/UserNav";
import { Alert } from "@/components/ui/Alert";
import { AppShell } from "@/components/ui/AppShell";
import { Badge } from "@/components/ui/Badge";
import { Button } from "@/components/ui/Button";
import { Card, SectionHeader } from "@/components/ui/Card";
import { cn } from "@/components/ui/cn";
import { CheckboxRow, Field, Input, Textarea } from "@/components/ui/Input";
import { uploadPhoto } from "@/lib/uploadPhoto";
import type { ReturnAdvice } from "@/lib/warehouse/returnAdvisor";
import {
  decisionFits,
  describePlan,
  planProblem,
  type ReturnDecisionNotSame,
  type ReturnPlan,
} from "@/lib/warehouse/returnPlan";
import type { ReturnCandidate } from "@/lib/warehouse/returns";
import { Camera, Check, ChevronRight, LoaderCircle, Minus, Plus, Printer, ThumbsDown, ThumbsUp, X } from "lucide-react";
import Link from "next/link";
import { useEffect, useState } from "react";

// Returns mode: a customer sent something back. Scan its label (or UPC for
// older items), say which order it came back from and whether it's still
// brand new. Brand new goes back on its listing, or onto a fresh copy if
// that sold out or ended. Anything else gets the return agent's call
// (src/lib/warehouse/returnAdvisor.ts): list it again in its real
// condition, Shopify & Whatnot only, dispose or donate. Employees never see
// money; the owner also sees the agent's money reasoning.

type Photo = { id: string; previewUrl: string; status: "uploading" | "done" | "error"; url?: string };

type Phase = "scan" | "pick" | "ask" | "yes" | "no" | "advice" | "done";

type Result = {
  decision: string;
  title: string;
  lines: string[];
  // Item whose labels the Reprint button prints, and how many.
  reprint: { itemId: string; copies: number } | null;
  next: string | null;
};

type RecentReturn = {
  id: string;
  createdAt: string;
  sku: string;
  title: string;
  units: number;
  orderId: string | null;
  sameCondition: boolean;
  decision: string;
  reason: string | null;
  overridden: boolean;
  suggested: string | null;
  newItemSku: string | null;
  recordedBy: string | null;
  ownerReason?: string | null;
};

const CONDITION_TEXT: Record<string, string> = {
  new: "New",
  new_other: "Open box",
  used: "Used",
  for_parts: "For parts",
};

const DECISION_TEXT: Record<string, string> = {
  add_back: "Back on its listing",
  relist_same: "New copy of the listing",
  relist_new: "List it again",
  shopify_only: "Shopify & Whatnot only",
  dispose: "Throw it away",
  donate: "Donate it",
};

const DECISION_TONE: Record<string, "success" | "primary" | "purple" | "danger" | "warning"> = {
  add_back: "success",
  relist_same: "success",
  relist_new: "primary",
  shopify_only: "purple",
  dispose: "danger",
  donate: "warning",
};

// Physical units in one listing unit: a 3-pack is 3, a single or a bundle 1.
function perUnitOf(c: ReturnCandidate): number {
  return c.isMultipack && c.packSize ? c.packSize : 1;
}

// The employee's own split, as typed (strings) while editing.
type PlanDraft = { listUnits: string; listPackSize: string; thrown: string; donate: string; missing: string };

function draftFrom(plan: ReturnPlan): PlanDraft {
  return {
    listUnits: String(plan.listUnits),
    listPackSize: String(plan.listPackSize),
    thrown: String(plan.thrownUnits),
    donate: String(plan.donateUnits),
    missing: String(plan.missingUnits),
  };
}

function planFrom(draft: PlanDraft, returnedUnits: number): ReturnPlan {
  const n = (v: string) => (v.trim() === "" ? 0 : Number(v));
  const listUnits = n(draft.listUnits);
  return {
    returnedUnits,
    listUnits,
    listPackSize: listUnits === 0 ? 1 : n(draft.listPackSize) || 1,
    thrownUnits: n(draft.thrown),
    donateUnits: n(draft.donate),
    missingUnits: n(draft.missing),
  };
}

// Where each part physically goes, after the plan's own words.
function placeLines(plan: ReturnPlan, decision: ReturnDecisionNotSame): string[] {
  return [
    plan.listUnits > 0
      ? decision === "shopify_only"
        ? "The listed part gets a new Shopify & Whatnot listing. Take new photos of exactly what's in it, show any damage."
        : "The listed part gets a new listing in its real condition. Take new photos of exactly what's in it, show any damage."
      : null,
    plan.thrownUnits > 0 ? "Put the thrown-out ones in the dispose bin." : null,
    plan.donateUnits > 0 ? "Put the donated ones in the donate box." : null,
  ].filter((l): l is string => l != null);
}

function unitWord(c: ReturnCandidate, n: number): string {
  const word = c.isBundle ? "bundle" : c.isMultipack && c.packSize ? `${c.packSize}-pack` : "unit";
  return `${word}${n === 1 ? "" : "s"}`;
}

function listingBadge(c: ReturnCandidate) {
  if (c.listing === "live") return <Badge tone="success">Live, {c.available} left</Badge>;
  if (c.listing === "sold_out") return <Badge tone="neutral">Sold out</Badge>;
  return <Badge tone="neutral">Ended</Badge>;
}

export default function ReturnsPage() {
  const isOwner = useCurrentUser()?.role === "owner";
  const stationChoice = useChosenStation(true);
  const station = stationChoice.station;

  const [phase, setPhase] = useState<Phase>("scan");
  const [code, setCode] = useState("");
  const [looking, setLooking] = useState(false);
  const [candidates, setCandidates] = useState<ReturnCandidate[]>([]);
  const [item, setItem] = useState<ReturnCandidate | null>(null);
  // Index into item.sales, or -1 for "not sure".
  const [saleIndex, setSaleIndex] = useState(-1);
  const [units, setUnits] = useState("1");

  const [missing, setMissing] = useState(false);
  const [opened, setOpened] = useState(false);
  const [used, setUsed] = useState(false);
  const [damaged, setDamaged] = useState(false);
  const [unitsHere, setUnitsHere] = useState("");
  const [damagedCount, setDamagedCount] = useState("");
  const [note, setNote] = useState("");
  const [photos, setPhotos] = useState<Photo[]>([]);

  const [advice, setAdvice] = useState<(ReturnAdvice & { adviceId: string }) | null>(null);
  const [showOverride, setShowOverride] = useState(false);
  const [draft, setDraft] = useState<PlanDraft | null>(null);
  const [draftChannel, setDraftChannel] = useState<"relist_new" | "shopify_only">("relist_new");
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [result, setResult] = useState<Result | null>(null);
  const [reprintMessage, setReprintMessage] = useState<string | null>(null);

  const [recent, setRecent] = useState<RecentReturn[] | null>(null);
  const [recentKey, setRecentKey] = useState(0);

  useEffect(() => {
    fetch("/api/returns")
      .then((r) => (r.ok ? r.json() : []))
      .then((rows) => setRecent(Array.isArray(rows) ? rows : []))
      .catch(() => setRecent([]));
  }, [recentKey]);

  const unitsNum = Number(units);
  // A returned 3-pack is 3 units: the report and the plan count pieces.
  const perUnit = item ? perUnitOf(item) : 1;
  const returnedUnits = (Number.isInteger(unitsNum) && unitsNum > 0 ? unitsNum : 1) * perUnit;
  const pieceWord = perUnit > 1 ? "pieces" : "units";
  const sale = item && saleIndex >= 0 ? item.sales[saleIndex] : null;

  function reset() {
    setPhase("scan");
    setCode("");
    setCandidates([]);
    setItem(null);
    setSaleIndex(-1);
    setUnits("1");
    setMissing(false);
    setOpened(false);
    setUsed(false);
    setDamaged(false);
    setUnitsHere("");
    setDamagedCount("");
    setNote("");
    setPhotos([]);
    setAdvice(null);
    setShowOverride(false);
    setDraft(null);
    setMessage(null);
    setResult(null);
    setReprintMessage(null);
    requestAnimationFrame(() => document.getElementById("return-code")?.focus());
  }

  function choose(c: ReturnCandidate) {
    setItem(c);
    setSaleIndex(c.sales.length > 0 ? 0 : -1);
    setPhase("ask");
  }

  async function lookup() {
    const scanned = code.trim();
    if (!scanned) return;
    setLooking(true);
    setMessage(null);
    try {
      const r = await fetch(`/api/returns/lookup?code=${encodeURIComponent(scanned)}`);
      const data = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(data.error ?? "Couldn't look that up.");
      const list = data.items as ReturnCandidate[];
      setCandidates(list);
      if (list.length === 1) choose(list[0]);
      else setPhase("pick");
    } catch (e) {
      setMessage(e instanceof Error ? e.message : "Couldn't look that up.");
      setCode("");
      requestAnimationFrame(() => document.getElementById("return-code")?.focus());
    } finally {
      setLooking(false);
    }
  }

  function checkUnits(): boolean {
    if (!Number.isInteger(unitsNum) || unitsNum < 1) {
      setMessage("Enter how many came back (at least 1).");
      return false;
    }
    return true;
  }

  function report() {
    return {
      missingUnits: missing,
      opened,
      used,
      damaged,
      unitsHere: missing && unitsHere !== "" ? Number(unitsHere) : null,
      damagedUnits: damaged && damagedCount !== "" ? Number(damagedCount) : null,
      note: note.trim() || null,
      photoUrls: photos.filter((p) => p.status === "done" && p.url).map((p) => p.url as string),
    };
  }

  async function post(body: Record<string, unknown>) {
    const r = await fetch("/api/returns", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        itemId: item?.id,
        channel: sale?.channel ?? null,
        orderId: sale?.orderId ?? null,
        units: unitsNum,
        stationId: station?.id ?? null,
        ...body,
      }),
    });
    const data = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(data.error ?? "Couldn't save the return.");
    return data;
  }

  async function saveSameCondition() {
    if (!item || !checkUnits()) return;
    if (item.listing !== "live" && !station) {
      window.scrollTo({ top: 0, behavior: "smooth" });
      setMessage("Scan your station's QR code first, so the new labels print there.");
      return;
    }
    setBusy(true);
    setMessage(null);
    try {
      const data = await post({ sameCondition: true });
      if (data.decision === "add_back") {
        setResult({
          decision: "add_back",
          title: `Added ${unitsNum} back to the listing.`,
          lines: ["Bag it with its label (reprint below if it's missing) and take it to the binning table."],
          reprint: { itemId: item.id, copies: unitsNum },
          next: null,
        });
      } else {
        setResult({
          decision: "relist_same",
          title: `New listing ${data.newItem.sku} made.`,
          lines: [
            `Printing ${data.labelsQueued} label${data.labelsQueued === 1 ? "" : "s"} at ${station?.name ?? "the station"}.`,
            "Put the new label on, bag it, and take it to the binning table. It goes through Review like any new item.",
          ],
          reprint: { itemId: data.newItem.id, copies: unitsNum },
          next: null,
        });
      }
      setPhase("done");
      setRecentKey((k) => k + 1);
    } catch (e) {
      setMessage(e instanceof Error ? e.message : "Couldn't save the return.");
    } finally {
      setBusy(false);
    }
  }

  async function getAdvice() {
    if (!item || !checkUnits()) return;
    if (!missing && !opened && !used && !damaged) {
      setMessage("Check at least one box: missing, opened, used or damaged.");
      return;
    }
    if (missing && (unitsHere === "" || !(Number(unitsHere) >= 0) || Number(unitsHere) > returnedUnits)) {
      setMessage(`Enter how many ${pieceWord} are actually here (0 to ${returnedUnits}).`);
      return;
    }
    if (photos.some((p) => p.status === "uploading")) {
      setMessage("Photos are still uploading, hang on a sec.");
      return;
    }
    setBusy(true);
    setMessage(null);
    try {
      const r = await fetch("/api/returns/advice", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          itemId: item.id,
          units: unitsNum,
          report: report(),
          channel: sale?.channel ?? null,
          orderId: sale?.orderId ?? null,
          // Asking again (went back and changed the report) updates the
          // same pending record instead of making another.
          adviceId: advice?.adviceId ?? null,
        }),
      });
      const data = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(data.error ?? "Couldn't get a recommendation.");
      setAdvice(data as ReturnAdvice & { adviceId: string });
      setShowOverride(false);
      setDraft(null);
      setPhase("advice");
    } catch (e) {
      setMessage(e instanceof Error ? e.message : "Couldn't get a recommendation.");
    } finally {
      setBusy(false);
    }
  }

  // plan: the employee's own split; left out = the agent's.
  async function decide(decision: ReturnDecisionNotSame, plan?: ReturnPlan) {
    if (!item) return;
    setBusy(true);
    setMessage(null);
    try {
      const data = await post({
        sameCondition: false,
        decision,
        report: report(),
        adviceId: advice?.adviceId ?? null,
        ...(plan ? { plan } : {}),
      });
      const done: ReturnPlan = data.plan;
      setResult({
        decision,
        title: DECISION_TEXT[decision],
        lines: [...describePlan(done, decision), ...placeLines(done, decision)],
        reprint: null,
        next: data.next ?? null,
      });
      setPhase("done");
      setRecentKey((k) => k + 1);
    } catch (e) {
      setMessage(e instanceof Error ? e.message : "Couldn't save the return.");
    } finally {
      setBusy(false);
    }
  }

  function saveDraft() {
    if (!draft) return;
    const plan = planFrom(draft, returnedUnits);
    const problem = planProblem(plan);
    if (problem) return setMessage(problem);
    const decision: ReturnDecisionNotSame =
      plan.listUnits > 0 ? draftChannel : plan.donateUnits > 0 && plan.thrownUnits === 0 ? "donate" : "dispose";
    if (!decisionFits(decision, plan)) return setMessage("Those counts don't fit together. Check them again.");
    decide(decision, plan);
  }

  async function reprint() {
    if (!result?.reprint) return;
    if (!station) {
      window.scrollTo({ top: 0, behavior: "smooth" });
      setMessage("Scan your station's QR code first, so the labels print there.");
      return;
    }
    setBusy(true);
    setReprintMessage(null);
    try {
      const r = await fetch(`/api/items/${result.reprint.itemId}/labels`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ stationId: station.id, copies: result.reprint.copies }),
      });
      const data = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(data.error ?? "Couldn't reprint.");
      setReprintMessage(`Sent ${data.labelsQueued} label${data.labelsQueued === 1 ? "" : "s"} to ${station.name}.`);
    } catch (e) {
      setReprintMessage(e instanceof Error ? e.message : "Couldn't reprint.");
    } finally {
      setBusy(false);
    }
  }

  function addPhotos(files: FileList | null) {
    if (!files) return;
    for (const file of Array.from(files)) {
      const id = `${Date.now()}-${Math.random()}`;
      setPhotos((prev) => [...prev, { id, previewUrl: URL.createObjectURL(file), status: "uploading" }]);
      uploadPhoto(file)
        .then((url) => setPhotos((prev) => prev.map((p) => (p.id === id ? { ...p, status: "done", url } : p))))
        .catch(() => setPhotos((prev) => prev.map((p) => (p.id === id ? { ...p, status: "error" } : p))));
    }
  }

  return (
    <AppShell
      width="narrow"
      title="Returns"
      subtitle="Scan what came back. It tells you where it goes."
      actions={
        phase !== "scan" ? (
          <Button variant="outline" size="sm" onClick={reset}>
            Start over
          </Button>
        ) : undefined
      }
    >
      <div className="flex flex-col gap-4">
        {/* A station is set by scanning its QR code, never picked (Cristian, 2026-10-26). */}
        {stationChoice.needsStation || stationChoice.error ? (
          <ScanStationCard
            description="New labels for returned items print there."
            error={stationChoice.error}
            onReload={stationChoice.reload}
          />
        ) : (
          station && (
            <div className="flex items-center justify-between gap-2 rounded-xl border border-border bg-surface px-3 py-2 text-sm shadow-sm">
              <span className="flex min-w-0 items-center gap-2">
                <span className="text-muted-foreground">Labels print at</span>
                <span className="truncate font-medium text-foreground">{station.name}</span>
                <StationOnline online={station.online || station.helperOnline} />
              </span>
              <StationSignOutButton stationId={station.id} stationName={station.name} />
            </div>
          )
        )}

        {phase === "scan" && (
          <Card>
            <ScanField
              id="return-code"
              label="Returned item"
              prompt="Scan its label, or the UPC if it has no label"
              autoFocus
              value={code}
              onChange={setCode}
              onScan={lookup}
              hint={looking ? "Looking it up…" : "The ES label, or the UPC on the package for older items."}
            />
          </Card>
        )}

        {phase === "pick" && (
          <section>
            <SectionHeader title="Which listing was it?" description="Most recent sale first." />
            <ul className="flex flex-col gap-2">
              {candidates.map((c) => (
                <li key={c.id}>
                  <button
                    type="button"
                    onClick={() => choose(c)}
                    className="flex w-full items-center gap-3 rounded-xl border border-border bg-surface p-3 text-left shadow-sm hover:bg-muted active:bg-muted"
                  >
                    {c.photoUrl && <img src={c.photoUrl} alt="" className="size-12 shrink-0 rounded-lg object-cover" />}
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-sm font-medium text-foreground">{c.title}</span>
                      <span className="mt-0.5 block text-xs text-muted-foreground">
                        {c.sku.length <= 10 ? `${c.sku} · ` : ""}
                        {c.sales[0] ? `Last sold ${new Date(c.sales[0].soldAt).toLocaleDateString()}` : "No sales found"}
                      </span>
                    </span>
                    <ChevronRight className="size-5 shrink-0 text-muted-foreground" aria-hidden />
                  </button>
                </li>
              ))}
            </ul>
          </section>
        )}

        {item && phase !== "scan" && phase !== "pick" && <ItemCard item={item} />}

        {item && phase === "ask" && (
          <>
            {item.sales.length > 0 && (
              <Card>
                <SectionHeader className="mb-2" title="Which order did it come back from?" />
                <div className="flex flex-col gap-1.5">
                  {item.sales.map((s, i) => (
                    <ChoiceRow key={`${s.label}-${s.soldAt}`} selected={saleIndex === i} onClick={() => setSaleIndex(i)}>
                      <span className="font-medium">{s.label}</span>
                      <span className="text-muted-foreground">
                        {" "}
                        · {s.quantity} sold {new Date(s.soldAt).toLocaleDateString()}
                      </span>
                    </ChoiceRow>
                  ))}
                  <ChoiceRow selected={saleIndex === -1} onClick={() => setSaleIndex(-1)}>
                    Not sure
                  </ChoiceRow>
                </div>
              </Card>
            )}

            <Card>
              <Stepper label="How many came back?" value={units} onChange={setUnits} suffix={unitWord(item, unitsNum || 1)} />
            </Card>

            <Card>
              <p className="text-lg font-semibold leading-snug text-foreground">Is it the same brand-new condition?</p>
              <p className="mt-1 text-sm text-muted-foreground">Sealed, nothing missing, every unit there.</p>
              <div className="mt-4 grid grid-cols-2 gap-3">
                <Button variant="success" size="xl" onClick={() => checkUnits() && setPhase("yes")}>
                  <ThumbsUp className="size-5" aria-hidden />
                  Yes
                </Button>
                <Button variant="danger" size="xl" onClick={() => checkUnits() && setPhase("no")}>
                  <ThumbsDown className="size-5" aria-hidden />
                  No
                </Button>
              </div>
            </Card>
          </>
        )}

        {item && phase === "yes" && (
          <Card className="flex flex-col gap-3">
            {item.listing === "live" ? (
              <p className="text-sm text-foreground">
                Its listing is still live, so the {unitsNum} {unitWord(item, unitsNum)} go back on it.
              </p>
            ) : (
              <p className="text-sm text-foreground">
                That listing is {item.listing === "sold_out" ? "sold out" : "ended"}, so this becomes a new listing with a new
                label. The old one stays down.
              </p>
            )}
            <Button variant="success" size="xl" block onClick={saveSameCondition} disabled={busy}>
              <Check className="size-5" aria-hidden />
              {busy ? "Saving…" : item.listing === "live" ? "Put it back on the listing" : "Make the new listing"}
            </Button>
            <Button variant="ghost" block onClick={() => setPhase("ask")}>
              Back
            </Button>
          </Card>
        )}

        {item && phase === "no" && (
          <Card className="flex flex-col gap-3">
            <SectionHeader className="mb-0" title="What's wrong with it?" description="Check everything that fits." />
            <CheckboxRow label="Missing units / pieces" checked={missing} onChange={(e) => setMissing(e.target.checked)} />
            {missing && (
              <Field label={`How many ${pieceWord} are actually here? (${returnedUnits} came back)`}>
                <Input
                  size="lg"
                  type="number"
                  min={0}
                  inputMode="numeric"
                  value={unitsHere}
                  onChange={(e) => setUnitsHere(e.target.value)}
                  onWheel={(e) => e.currentTarget.blur()}
                />
              </Field>
            )}
            <CheckboxRow label="Opened" checked={opened} onChange={(e) => setOpened(e.target.checked)} />
            <CheckboxRow label="Used" checked={used} onChange={(e) => setUsed(e.target.checked)} />
            <CheckboxRow label="Damaged" checked={damaged} onChange={(e) => setDamaged(e.target.checked)} />
            {damaged && (
              <Field label={`How many ${pieceWord} are damaged?`} hint="Leave blank if all of them are.">
                <Input
                  size="lg"
                  type="number"
                  min={0}
                  inputMode="numeric"
                  value={damagedCount}
                  onChange={(e) => setDamagedCount(e.target.value)}
                  onWheel={(e) => e.currentTarget.blur()}
                />
              </Field>
            )}
            <Field label="Note (optional)">
              <Textarea rows={2} value={note} onChange={(e) => setNote(e.target.value)} placeholder="e.g. one tube missing its cap" />
            </Field>
            <div>
              <p className="mb-1.5 text-sm font-medium text-foreground">Photos (optional)</p>
              <div className="grid grid-cols-4 gap-2">
                {photos.map((p) => (
                  <div key={p.id} className="relative aspect-square">
                    <img src={p.previewUrl} alt="" className="size-full rounded-lg border border-border object-cover" />
                    {p.status === "uploading" && (
                      <div className="absolute inset-0 grid place-items-center rounded-lg bg-zinc-950/45">
                        <LoaderCircle className="size-5 animate-spin text-white" aria-label="Uploading" />
                      </div>
                    )}
                    {p.status === "error" && (
                      <div className="absolute inset-0 grid place-items-center rounded-lg bg-red-600/75 text-xs font-medium text-white">
                        Failed
                      </div>
                    )}
                    <button
                      type="button"
                      onClick={() => setPhotos((prev) => prev.filter((x) => x.id !== p.id))}
                      aria-label="Remove photo"
                      className="absolute -right-1.5 -top-1.5 grid size-6 place-items-center rounded-full bg-zinc-900 text-white"
                    >
                      <X className="size-3.5" aria-hidden />
                    </button>
                  </div>
                ))}
                <label className="flex aspect-square cursor-pointer flex-col items-center justify-center gap-1 rounded-lg border-2 border-dashed border-zinc-300 text-xs font-medium text-muted-foreground hover:border-primary hover:text-primary">
                  <Camera className="size-5" aria-hidden />
                  Add
                  <input
                    type="file"
                    accept="image/*"
                    capture="environment"
                    multiple
                    className="hidden"
                    onChange={(e) => addPhotos(e.target.files)}
                  />
                </label>
              </div>
            </div>
            <Button size="xl" block onClick={getAdvice} disabled={busy}>
              {busy ? (
                <>
                  <LoaderCircle className="size-5 animate-spin" aria-hidden />
                  Thinking…
                </>
              ) : (
                "What do I do with it?"
              )}
            </Button>
            <Button variant="ghost" block onClick={() => setPhase("ask")}>
              Back
            </Button>
          </Card>
        )}

        {item && phase === "advice" && advice && (
          <Card className="flex flex-col gap-3">
            <div>
              <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">Do this</p>
              <p className="mt-1 text-2xl font-semibold text-foreground">
                {DECISION_TEXT[advice.decision]}
                {advice.condition && advice.decision === "relist_new" ? ` as ${CONDITION_TEXT[advice.condition]}` : ""}
              </p>
              {advice.decision === "shopify_only" && advice.condition && (
                <p className="text-sm text-muted-foreground">As {CONDITION_TEXT[advice.condition]}</p>
              )}
              <ul className="mt-2 flex flex-col gap-1 text-sm font-medium text-foreground">
                {describePlan(advice.plan, advice.decision).map((l) => (
                  <li key={l}>{l}</li>
                ))}
              </ul>
              <p className="mt-2 text-sm text-muted-foreground">{advice.reason}</p>
              {advice.basis === "fallback" && (
                <p className="mt-1 text-xs text-muted-foreground">Rules-based call (the agent didn&apos;t answer).</p>
              )}
            </div>
            {isOwner && advice.ownerReason && (
              <div className="rounded-lg border border-border bg-background p-3 text-sm text-foreground">
                <p className="mb-1 text-xs font-medium text-muted-foreground">Money side (only you see this)</p>
                {advice.ownerReason}
              </div>
            )}
            <Button variant="success" size="xl" block onClick={() => decide(advice.decision)} disabled={busy}>
              <Check className="size-5" aria-hidden />
              {busy ? "Saving…" : "Do this"}
            </Button>
            {!showOverride || !draft ? (
              <Button
                variant="ghost"
                block
                onClick={() => {
                  setDraft(draftFrom(advice.plan));
                  setDraftChannel(advice.decision === "shopify_only" ? "shopify_only" : "relist_new");
                  setShowOverride(true);
                }}
              >
                Do something else
              </Button>
            ) : (
              <PlanEditor
                draft={draft}
                onChange={setDraft}
                channel={draftChannel}
                onChannel={setDraftChannel}
                returnedUnits={returnedUnits}
                pieceWord={pieceWord}
                busy={busy}
                onSave={saveDraft}
              />
            )}
            <Button variant="ghost" block onClick={() => setPhase("no")} disabled={busy}>
              Change what&apos;s wrong with it
            </Button>
          </Card>
        )}

        {phase === "done" && result && (
          <Card className="flex flex-col gap-3">
            <div className="flex items-start gap-2">
              <Badge tone={DECISION_TONE[result.decision] ?? "neutral"} size="lg">
                {DECISION_TEXT[result.decision]}
              </Badge>
            </div>
            <p className="text-lg font-semibold text-foreground">{result.title}</p>
            {result.lines.map((l) => (
              <p key={l} className="text-sm text-foreground">
                {l}
              </p>
            ))}
            {result.reprint && (
              <Button variant="outline" size="lg" block onClick={reprint} disabled={busy}>
                <Printer className="size-5" aria-hidden />
                Reprint {result.reprint.copies === 1 ? "label" : `${result.reprint.copies} labels`}
              </Button>
            )}
            {reprintMessage && <p className="text-sm text-muted-foreground">{reprintMessage}</p>}
            {result.next && (
              <Link
                href={result.next}
                className="inline-flex h-14 items-center justify-center gap-2 rounded-lg bg-primary px-6 text-base font-medium text-primary-foreground shadow-sm hover:bg-primary-hover"
              >
                Start the new listing
                <ChevronRight className="size-5" aria-hidden />
              </Link>
            )}
            <Button variant={result.next ? "ghost" : "primary"} size="lg" block onClick={reset}>
              Next return
            </Button>
          </Card>
        )}

        {message && <Alert tone="warning">{message}</Alert>}

        <RecentReturns rows={recent} isOwner={isOwner} />
      </div>
    </AppShell>
  );
}

// The employee's own split of the returned units, when the agent's call
// isn't right. Saved as an override (ItemReturn.report.overridden).
function PlanEditor({
  draft,
  onChange,
  channel,
  onChannel,
  returnedUnits,
  pieceWord,
  busy,
  onSave,
}: {
  draft: PlanDraft;
  onChange: (d: PlanDraft) => void;
  channel: "relist_new" | "shopify_only";
  onChannel: (c: "relist_new" | "shopify_only") => void;
  returnedUnits: number;
  pieceWord: string;
  busy: boolean;
  onSave: () => void;
}) {
  const plan = planFrom(draft, returnedUnits);
  const placed = plan.listUnits + plan.thrownUnits + plan.donateUnits + plan.missingUnits;
  const set = (key: keyof PlanDraft) => (e: React.ChangeEvent<HTMLInputElement>) => onChange({ ...draft, [key]: e.target.value });
  const num = (key: keyof PlanDraft, label: string, hint?: string) => (
    <Field label={label} hint={hint}>
      <Input type="number" min={0} inputMode="numeric" value={draft[key]} onChange={set(key)} onWheel={(e) => e.currentTarget.blur()} />
    </Field>
  );
  return (
    <div className="flex flex-col gap-3 rounded-lg border border-border bg-background p-3">
      <p className="text-sm font-semibold text-foreground">Your plan ({returnedUnits} {pieceWord} came back)</p>
      <div className="grid grid-cols-2 gap-3">
        {num("listUnits", "List")}
        {num("listPackSize", "Per listing", "1 = singles, 2 = 2-packs")}
        {num("thrown", "Throw out")}
        {num("donate", "Donate")}
        {num("missing", "Missing")}
      </div>
      {plan.listUnits > 0 && (
        <div className="grid grid-cols-2 gap-2">
          <ChoiceRow selected={channel === "relist_new"} onClick={() => onChannel("relist_new")}>
            eBay
          </ChoiceRow>
          <ChoiceRow selected={channel === "shopify_only"} onClick={() => onChannel("shopify_only")}>
            Shopify &amp; Whatnot
          </ChoiceRow>
        </div>
      )}
      <p className={cn("text-sm tabular-nums", placed === returnedUnits ? "text-muted-foreground" : "text-warning")}>
        {placed} of {returnedUnits} placed
      </p>
      <Button variant="success" size="lg" block onClick={onSave} disabled={busy}>
        <Check className="size-5" aria-hidden />
        {busy ? "Saving…" : "Do my plan instead"}
      </Button>
    </div>
  );
}

function ItemCard({ item }: { item: ReturnCandidate }) {
  return (
    <Card padded={false} className="flex gap-3 p-3">
      {item.photoUrl && <img src={item.photoUrl} alt="" className="size-20 shrink-0 rounded-lg object-cover" />}
      <div className="min-w-0 flex-1">
        <p className="text-sm font-semibold leading-snug text-foreground">{item.title}</p>
        <div className="mt-1.5 flex flex-wrap gap-1.5">
          {listingBadge(item)}
          {item.isMultipack && item.packSize && <Badge tone="primary">Pack of {item.packSize}</Badge>}
          {item.condition && <Badge>{CONDITION_TEXT[item.condition] ?? item.condition}</Badge>}
          {item.expirationDate && <Badge tone="warning">Exp {item.expirationDate}</Badge>}
          {item.shopifyOnly && <Badge tone="purple">Shopify only</Badge>}
        </div>
        <p className="mt-1 text-xs tabular-nums text-muted-foreground">{item.sku.length <= 10 ? item.sku : item.upc ? `UPC ${item.upc}` : ""}</p>
      </div>
    </Card>
  );
}

function ChoiceRow({ selected, onClick, children }: { selected: boolean; onClick: () => void; children: React.ReactNode }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        "flex min-h-11 w-full items-center gap-2 rounded-lg border px-3 py-2 text-left text-sm",
        selected ? "border-primary bg-blue-50 text-foreground" : "border-border bg-surface text-foreground hover:bg-muted"
      )}
    >
      <span
        className={cn("grid size-4 shrink-0 place-items-center rounded-full border", selected ? "border-primary" : "border-zinc-300")}
        aria-hidden
      >
        {selected && <span className="size-2 rounded-full bg-primary" />}
      </span>
      <span className="min-w-0">{children}</span>
    </button>
  );
}

function Stepper({
  label,
  value,
  onChange,
  suffix,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  suffix: string;
}) {
  return (
    <div>
      <p className="mb-1.5 text-sm font-medium text-foreground">{label}</p>
      <div className="grid grid-cols-[3.5rem_1fr_3.5rem] gap-2">
        <Button
          variant="outline"
          size="icon-xl"
          aria-label="One less"
          onClick={() => onChange(String(Math.max(1, (Number(value) || 1) - 1)))}
        >
          <Minus className="size-5" aria-hidden />
        </Button>
        <Input
          size="lg"
          type="number"
          min={1}
          inputMode="numeric"
          className="text-center"
          value={value}
          onChange={(e) => onChange(e.target.value)}
          onWheel={(e) => e.currentTarget.blur()}
        />
        <Button variant="outline" size="icon-xl" aria-label="One more" onClick={() => onChange(String((Number(value) || 0) + 1))}>
          <Plus className="size-5" aria-hidden />
        </Button>
      </div>
      <p className="mt-1 text-center text-xs text-muted-foreground">{suffix}</p>
    </div>
  );
}

function RecentReturns({ rows, isOwner }: { rows: RecentReturn[] | null; isOwner: boolean }) {
  if (!rows || rows.length === 0) return null;
  return (
    <section>
      <SectionHeader title="Today's returns" action={<Badge>{rows.length}</Badge>} />
      <ul className="divide-y divide-border rounded-xl border border-border bg-surface text-sm">
        {rows.map((r) => (
          <li key={r.id} className="px-3 py-2.5">
            <div className="flex items-start justify-between gap-2">
              <p className="min-w-0 truncate font-medium text-foreground">{r.title}</p>
              <Badge tone={DECISION_TONE[r.decision] ?? "neutral"}>{DECISION_TEXT[r.decision] ?? r.decision}</Badge>
            </div>
            <p className="mt-0.5 text-xs text-muted-foreground">
              {r.units} back
              {r.orderId ? ` · order ${r.orderId}` : ""}
              {r.newItemSku ? ` · new ${r.newItemSku}` : ""}
              {r.recordedBy ? ` · ${r.recordedBy}` : ""}
              {" · "}
              {new Date(r.createdAt).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })}
            </p>
            {r.overridden && r.suggested && (
              <p className="mt-0.5 text-xs text-warning">Suggested: {DECISION_TEXT[r.suggested] ?? r.suggested}</p>
            )}
            {r.reason && <p className="mt-0.5 text-xs text-foreground">{r.reason}</p>}
            {isOwner && r.ownerReason && <p className="mt-1 text-xs text-muted-foreground">{r.ownerReason}</p>}
          </li>
        ))}
      </ul>
    </section>
  );
}

