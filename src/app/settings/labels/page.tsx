"use client";

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
      <div className="flex items-center justify-between p-4 print:hidden">
        <h1 className="text-lg font-semibold">
          {labels ? `${labels.length} label${labels.length === 1 ? "" : "s"}` : "Loading…"}
        </h1>
        <button
          type="button"
          onClick={() => window.print()}
          disabled={!labels || labels.length === 0}
          className="rounded bg-black px-4 py-2 text-sm text-white disabled:opacity-40"
        >
          Print
        </button>
      </div>

      {error && <p className="p-4 text-sm text-red-600 print:hidden">{error}</p>}

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
