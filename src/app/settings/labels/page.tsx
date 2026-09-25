"use client";

import { Button, buttonClasses } from "@/components/ui/Button";
import { ArrowLeft, Printer } from "lucide-react";
import Link from "next/link";
import { useEffect, useState } from "react";
import JsBarcode from "jsbarcode";
import { parseLocationRange } from "@/lib/locationRange";
import { naturalSort } from "@/lib/naturalSort";

// Printable Code128 barcode labels for shelf locations, sized for a 1"x2"
// label. No range in the URL = every saved location; a range like
// "A25-A40" prints just that slice, even for locations not saved yet (handy
// for pre-printing labels for shelves you haven't stocked out yet).
export default function LabelsPage() {
  const [labels, setLabels] = useState<string[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const range = new URLSearchParams(window.location.search).get("range");
    if (range) {
      try {
        // eslint-disable-next-line react-hooks/set-state-in-effect
        setLabels(parseLocationRange(range));
      } catch (e) {
        setError(e instanceof Error ? e.message : "Invalid range.");
        setLabels([]);
      }
      return;
    }
    fetch("/api/shelf-locations")
      .then((r) => r.json())
      .then((entries: { label: string }[]) => {
        setLabels(naturalSort(entries, (e) => e.label).map((e) => e.label));
      });
  }, []);

  return (
    <div>
      <div className="sticky top-0 z-10 flex items-center justify-between gap-3 border-b border-border bg-surface/90 px-4 py-3 backdrop-blur print:hidden">
        <div className="flex items-center gap-3">
          <Link href="/settings" className={buttonClasses({ variant: "ghost", size: "sm" })}>
            <ArrowLeft className="size-4" aria-hidden />
            Settings
          </Link>
          <h1 className="font-semibold text-foreground">
            {labels ? `${labels.length} shelf label${labels.length === 1 ? "" : "s"}` : "Loading…"}
          </h1>
        </div>
        <Button onClick={() => window.print()} disabled={!labels || labels.length === 0}>
          <Printer className="size-4" aria-hidden />
          Print
        </Button>
      </div>

      {error && <p className="p-4 text-sm font-medium text-danger print:hidden">{error}</p>}

      <div className="flex flex-wrap gap-3 p-4 print:gap-0 print:p-0">
        {labels?.map((label) => (
          <div key={label} className="label">
            <svg
              ref={(el) => {
                if (el) {
                  JsBarcode(el, label, {
                    format: "CODE128",
                    displayValue: false,
                    margin: 0,
                    height: 40,
                  });
                }
              }}
            />
            <div className="label-text">{label}</div>
          </div>
        ))}
      </div>

      <style>{`
        .label {
          width: 2in;
          height: 1in;
          display: flex;
          flex-direction: column;
          align-items: center;
          justify-content: center;
          overflow: hidden;
          border: 1px solid #ddd;
          border-radius: 6px;
          background: #fff;
        }
        .label-text {
          font-family: monospace;
          font-weight: bold;
          font-size: 16pt;
          margin-top: 2pt;
        }
        @media print {
          .label {
            border: none;
            border-radius: 0;
            page-break-after: always;
            break-after: page;
          }
          @page {
            size: 2in 1in;
            margin: 0;
          }
        }
      `}</style>
    </div>
  );
}
