import { labelsDocument, type LabelSpec } from "@/components/labels/labelMarkup";
import type { PrintJobKind, PrintJobPayload } from "./types";

// Prints 2" x 1" labels straight from the current browser: the station
// page uses it for queued jobs, and any page can call it as a fallback
// ("print here") when no station is set up. Client only.
//
// How: the labels go into a hidden iframe as their own little document
// (one label per page, sized with @page), and that iframe's print() is
// called. On the station PC Chrome runs with --kiosk-printing, so print()
// sends straight to the default printer (the Rollo) with no dialog.
// Anywhere else the normal print dialog opens.
//
// print() can't tell us whether paper actually came out; it only throws if
// printing couldn't start. So "printed" means "sent to the printer".

let queue: Promise<void> = Promise.resolve();

export function printLabels(kind: PrintJobKind, payload: PrintJobPayload, copies = 1): Promise<void> {
  return printLabelBatch([{ kind, payload, copies }]);
}

// Several different labels in one print (e.g. every box barcode at once).
// Calls are lined up one after another: Chrome ignores a print() while
// another one is still open.
export function printLabelBatch(labels: LabelSpec[]): Promise<void> {
  const run = queue.then(() => printDocument(labelsDocument(labels)));
  queue = run.catch(() => {});
  return run;
}

// Any other printable page (the 4x6 local delivery label), same way. size
// is the page, matching the document's own @page size.
export function printPage(html: string, size: { width: string; height: string }): Promise<void> {
  const run = queue.then(() => printDocument(html, size));
  queue = run.catch(() => {});
  return run;
}

function printDocument(html: string, size: { width: string; height: string } = { width: "2in", height: "1in" }): Promise<void> {
  return new Promise((resolve, reject) => {
    if (typeof document === "undefined") {
      reject(new Error("Printing only works in the browser."));
      return;
    }
    const frame = document.createElement("iframe");
    frame.setAttribute("aria-hidden", "true");
    frame.tabIndex = -1;
    // Off screen but real size: Chrome prints a blank page from an iframe
    // that's display:none or 0x0.
    Object.assign(frame.style, {
      position: "fixed",
      left: "-10000px",
      top: "0",
      width: size.width,
      height: size.height,
      border: "0",
    });

    let settled = false;
    const finish = (err?: Error) => {
      if (settled) return;
      settled = true;
      // Leave it in place a moment: removing the frame right as print()
      // returns can cancel the job in some Chrome versions.
      setTimeout(() => frame.remove(), 5000);
      if (err) reject(err);
      else resolve();
    };

    frame.onload = () => {
      const win = frame.contentWindow;
      if (!win) {
        finish(new Error("Couldn't open the label for printing."));
        return;
      }
      try {
        win.focus();
        // Blocks until the job is spooled (kiosk mode) or the dialog closes.
        win.print();
        finish();
      } catch (e) {
        finish(e instanceof Error ? e : new Error("Printing failed."));
      }
    };
    setTimeout(() => finish(new Error("The label took too long to load for printing.")), 15000);

    frame.srcdoc = html;
    document.body.appendChild(frame);
  });
}
