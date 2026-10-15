"use client";

import { Alert } from "@/components/ui/Alert";
import { Button } from "@/components/ui/Button";
import { Card, SectionHeader } from "@/components/ui/Card";
import { CheckboxRow, Field, Input, Select } from "@/components/ui/Input";
import { cn } from "@/components/ui/cn";
import {
  applyMapping,
  columnLabels,
  guessHeaderRow,
  guessMapping,
  headerSignature,
  sampleValue,
  upcCheckDigitReport,
  type ColumnMapping,
  type MappableField,
} from "@/lib/customManifest";
import { detectSupplier } from "@/lib/manifestParsers";
import { readSpreadsheet, type SheetGrid } from "@/lib/spreadsheetRows";
import { Upload } from "lucide-react";
import { useMemo, useRef, useState } from "react";

// Mappings saved per header layout, so a supplier sent once is recognized
// the next time on this device. Per-device convenience only — a fresh
// guess is always one click away.
const SAVED_MAPPINGS_KEY = "customManifestMappings";

function loadSavedMapping(signature: string): ColumnMapping | null {
  try {
    const all = JSON.parse(localStorage.getItem(SAVED_MAPPINGS_KEY) ?? "{}");
    return all[signature] ?? null;
  } catch {
    return null;
  }
}

function saveMapping(signature: string, mapping: ColumnMapping) {
  try {
    const all = JSON.parse(localStorage.getItem(SAVED_MAPPINGS_KEY) ?? "{}");
    all[signature] = mapping;
    localStorage.setItem(SAVED_MAPPINGS_KEY, JSON.stringify(all));
  } catch {
    // storage blocked: the mapping just isn't remembered
  }
}

type MapperState = SheetGrid & { fileName: string; mapping: ColumnMapping; reason: string; remembered: boolean };

// Upload card shared by the Analyzer (purchased=false) and Manifests
// (purchased=true). BStock / Liquidation.com CSVs upload straight through
// as before; anything else (an .xlsx, an unrecognized CSV, or the "other
// supplier" box checked) opens the column mapper first.
export function ManifestUpload({
  purchased,
  title: cardTitle,
  titlePlaceholder,
  onUploaded,
}: {
  purchased: boolean;
  title: string;
  titlePlaceholder: string;
  onUploaded: () => void;
}) {
  const [title, setTitle] = useState("");
  const [otherSupplier, setOtherSupplier] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [mapper, setMapper] = useState<MapperState | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  function reset() {
    setTitle("");
    setMapper(null);
    if (fileInputRef.current) fileInputRef.current.value = "";
  }

  async function post(body: Record<string, unknown>) {
    setUploading(true);
    try {
      const res = await fetch("/api/manifests", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ...body, purchased }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? "Upload failed.");
      reset();
      onUploaded();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Something went wrong.");
    } finally {
      setUploading(false);
    }
  }

  async function handleFile(file: File) {
    setError(null);
    setMapper(null);
    const isCsv = /\.csv$/i.test(file.name) || file.type === "text/csv";

    if (isCsv && !otherSupplier) {
      const csvContent = await file.text();
      const supplier = detectSupplier(csvContent.replace(/^﻿/, "").split(/\r?\n/)[0] ?? "");
      if (supplier !== "unknown") {
        // Detected supplier prefills a reasonable title, but only if the
        // user hasn't already typed their own.
        const label = supplier === "bstock" ? "BStock" : "Liquidation.com";
        await post({ title: title.trim() || `${label} — ${new Date().toLocaleDateString()}`, csvContent });
        return;
      }
    }

    try {
      const grid = await readSpreadsheet(file);
      const headerRow = guessHeaderRow(grid.rows);
      const signature = headerSignature(grid.rows, headerRow);
      const saved = loadSavedMapping(signature);
      setMapper({
        ...grid,
        fileName: file.name,
        mapping: saved ?? guessMapping(grid.rows, headerRow, grid.hiddenColumns),
        remembered: saved != null,
        reason: otherSupplier
          ? ""
          : isCsv
            ? "This isn't a BStock or Liquidation.com layout, so show the app where everything is."
            : "Spreadsheet files from other suppliers need their columns pointed out once.",
      });
    } catch (e) {
      setError(e instanceof Error ? e.message : "Couldn't read that file.");
    }
  }

  return (
    <Card>
      <SectionHeader
        title={cardTitle}
        description="BStock and Liquidation.com CSVs are detected automatically. Other suppliers' .xlsx or .csv files: point out the columns once."
      />
      <div className="flex flex-col gap-3 sm:flex-row sm:items-end">
        <Field label="Title" hint="Optional — auto-filled from the file if left blank." className="flex-1">
          <Input type="text" value={title} onChange={(e) => setTitle(e.target.value)} placeholder={titlePlaceholder} />
        </Field>
        <Button size="lg" onClick={() => fileInputRef.current?.click()} disabled={uploading} className="sm:mb-6">
          <Upload className="size-5" aria-hidden />
          {uploading ? "Uploading…" : "Choose file"}
        </Button>
        <input
          ref={fileInputRef}
          type="file"
          accept=".csv,.xlsx,text/csv,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
          onChange={(e) => {
            const file = e.target.files?.[0];
            if (file) handleFile(file);
          }}
          disabled={uploading}
          className="hidden"
        />
      </div>
      <CheckboxRow
        label="Different supplier, I'll show where the columns are"
        description="Pick where the description, quantity, UPC and prices are, including when quantity is in cases."
        className="mt-3"
        checked={otherSupplier}
        onChange={(e) => setOtherSupplier(e.target.checked)}
      />
      {error && <p className="mt-3 text-sm font-medium text-danger">{error}</p>}

      {mapper && (
        <ColumnMapper
          state={mapper}
          onChange={(mapping) => setMapper({ ...mapper, mapping })}
          onCancel={reset}
          uploading={uploading}
          onUpload={(lines) => {
            saveMapping(headerSignature(mapper.rows, mapper.mapping.headerRow), mapper.mapping);
            post({ title: title.trim() || mapper.fileName.replace(/\.(xlsx|csv)$/i, ""), lines });
          }}
        />
      )}
    </Card>
  );
}

const FIELDS: { key: MappableField; label: string; hint?: string; required?: boolean }[] = [
  { key: "description", label: "Description", required: true },
  {
    key: "quantity",
    label: "Quantity",
    required: true,
    hint: "Use the total-units column if there is one (e.g. Total Pieces).",
  },
  {
    key: "packSize",
    label: "Units per case",
    hint: "Only if Quantity counts cases: units = Quantity × this.",
  },
  { key: "upc", label: "UPC" },
  { key: "sku", label: "Item # / SKU" },
  { key: "unitRetail", label: "Retail price (each)" },
  { key: "totalRetail", label: "Total retail" },
  { key: "category", label: "Category" },
  { key: "condition", label: "Condition" },
];

function ColumnMapper({
  state,
  onChange,
  onCancel,
  onUpload,
  uploading,
}: {
  state: MapperState;
  onChange: (m: ColumnMapping) => void;
  onCancel: () => void;
  onUpload: (lines: ReturnType<typeof applyMapping>) => void;
  uploading: boolean;
}) {
  const { rows, hiddenColumns, mapping } = state;
  const hidden = useMemo(() => new Set(hiddenColumns), [hiddenColumns]);
  const labels = useMemo(() => columnLabels(rows, mapping.headerRow), [rows, mapping.headerRow]);
  const lines = useMemo(() => applyMapping(rows, mapping), [rows, mapping]);
  const upcReport = useMemo(() => upcCheckDigitReport(rows, mapping), [rows, mapping]);

  const totalUnits = lines.reduce((s, l) => s + l.expectedQuantity, 0);
  const totalRetail = lines.reduce((s, l) => s + l.extendedRetail, 0);
  const mapped = new Set(FIELDS.map((f) => mapping[f.key]).filter((c): c is number => c != null));

  // Names + a sample value instead of letters: hidden columns make Excel's
  // letters skip, so "the 9th column you can see" isn't column I.
  const columnOption = (i: number) => {
    const sample = sampleValue(rows, mapping.headerRow, i);
    const short = sample.length > 28 ? `${sample.slice(0, 28)}…` : sample;
    return `${labels[i]}${short ? ` (e.g. ${short})` : ""}${hidden.has(i) ? " · hidden in Excel" : ""}`;
  };

  const headerOptions = rows.slice(0, 30).map((r, i) => {
    const preview = r.filter((v) => v.trim()).slice(0, 4).join(", ");
    return { i, text: `Row ${i + 1}${preview ? `: ${preview.length > 50 ? preview.slice(0, 50) + "…" : preview}` : " (empty)"}` };
  });

  return (
    <div className="mt-5 flex flex-col gap-4 border-t border-border pt-5">
      <div>
        <p className="font-semibold text-foreground">Where is everything in {state.fileName}?</p>
        <p className="mt-0.5 text-sm text-muted-foreground">
          {state.remembered
            ? "Same layout as a file you mapped before, so your last choices are filled in."
            : `${state.reason ? state.reason + " " : ""}Best guesses are filled in. Check them against the preview below.`}
        </p>
      </div>

      <Field label="Column titles are on">
        <Select
          value={mapping.headerRow}
          onChange={(e) => {
            const headerRow = Number(e.target.value);
            onChange(guessMapping(rows, headerRow, hiddenColumns));
          }}
        >
          {headerOptions.map((o) => (
            <option key={o.i} value={o.i}>
              {o.text}
            </option>
          ))}
        </Select>
      </Field>

      <div className="grid gap-3 sm:grid-cols-2">
        {FIELDS.map((f) => (
          <Field key={f.key} label={`${f.label}${f.required ? " *" : ""}`} hint={f.hint}>
            <Select
              value={mapping[f.key] ?? ""}
              onChange={(e) => onChange({ ...mapping, [f.key]: e.target.value === "" ? null : Number(e.target.value) })}
            >
              <option value="">{f.required ? "Pick a column…" : "Not in this file"}</option>
              {labels.map((_, i) => (
                <option key={i} value={i}>
                  {columnOption(i)}
                </option>
              ))}
            </Select>
          </Field>
        ))}
      </div>

      <div>
        <p className="mb-1.5 text-sm font-medium text-foreground">Add to the description</p>
        <p className="mb-2 text-xs text-muted-foreground">
          For details like Size that tell otherwise-identical lines apart.
        </p>
        <div className="flex flex-wrap gap-2">
          {labels.map((label, i) => {
            if (hidden.has(i) || mapped.has(i) || !sampleValue(rows, mapping.headerRow, i)) return null;
            const on = mapping.extraDescription.includes(i);
            return (
              <button
                key={i}
                type="button"
                aria-pressed={on}
                onClick={() =>
                  onChange({
                    ...mapping,
                    extraDescription: on ? mapping.extraDescription.filter((c) => c !== i) : [...mapping.extraDescription, i],
                  })
                }
                className={cn(
                  "rounded-full border px-3 py-1.5 text-sm transition-colors",
                  on ? "border-primary bg-blue-50 font-medium text-primary" : "border-border bg-surface text-foreground hover:bg-muted"
                )}
              >
                {label}
              </button>
            );
          })}
        </div>
      </div>

      {mapping.upc != null && upcReport.short > 0 && (
        <CheckboxRow
          label="UPCs are missing their last digit, add it"
          description={`${upcReport.failing} of ${upcReport.short} short UPCs fail the barcode check${
            upcReport.looksMissing ? ", so this supplier left off the check digit. Leave this on so scans and price lookups match." : "."
          }`}
          checked={mapping.fixUpcCheckDigit}
          onChange={(e) => onChange({ ...mapping, fixUpcCheckDigit: e.target.checked })}
        />
      )}

      <div>
        <p className="mb-2 text-sm font-medium text-foreground">
          Preview: {lines.length.toLocaleString()} lines · {totalUnits.toLocaleString()} units
          {totalRetail > 0 && <> · ${totalRetail.toLocaleString(undefined, { maximumFractionDigits: 0 })} retail</>}
        </p>
        {lines.length > 0 && totalRetail === 0 && (
          <Alert tone="info" className="mb-2">
            No retail prices in this file. The analyzer will price it from eBay and web comps instead.
          </Alert>
        )}
        {lines.length > 0 && (
          <div className="overflow-x-auto rounded-lg border border-border">
            <table className="w-full text-left text-sm">
              <thead className="bg-muted text-xs text-muted-foreground">
                <tr>
                  <th className="px-3 py-2 font-medium">Description</th>
                  <th className="px-3 py-2 font-medium">UPC</th>
                  <th className="px-3 py-2 text-right font-medium">Units</th>
                  <th className="px-3 py-2 text-right font-medium">Retail ea.</th>
                </tr>
              </thead>
              <tbody>
                {lines.slice(0, 6).map((l, i) => (
                  <tr key={i} className="border-t border-border">
                    <td className="min-w-48 px-3 py-2">{l.description}</td>
                    <td className="px-3 py-2 tabular-nums">{l.upc ?? "—"}</td>
                    <td className="px-3 py-2 text-right tabular-nums">{l.expectedQuantity}</td>
                    <td className="px-3 py-2 text-right tabular-nums">{l.retailPrice > 0 ? `$${l.retailPrice.toFixed(2)}` : "—"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      <div className="flex flex-wrap gap-2">
        <Button onClick={() => onUpload(lines)} disabled={uploading || lines.length === 0}>
          {uploading ? "Uploading…" : `Upload ${lines.length.toLocaleString()} lines`}
        </Button>
        <Button variant="ghost" onClick={onCancel} disabled={uploading}>
          Cancel
        </Button>
      </div>
    </div>
  );
}
