import { code128Bits } from "@/components/labels/barcode";
import type { DeliveryView, ShipFrom } from "./deliveries";

// The 4" x 6" local delivery label, as a printable page (printPage in
// warehouse/labelPrint.ts). Client and server safe: plain strings.
//
// The barcode is the delivery's code (D1001). At the door the driver scans
// it and the app checks it against the stop, so the wrong bag never gets
// left at the wrong house.
//
// Nothing on it says what's inside, not even an item count (Cristian: a bag
// left at a door shouldn't tell a passer-by it's worth taking).

function esc(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
}

// Bars drawn in whole modules, 0.025in each (5 dots at the Rollo's
// 203 dpi), so even a worn print head scans.
function barcode(code: string): string {
  const bits = code128Bits(code);
  if (!bits) return `<p class="code">${esc(code)}</p>`;
  let rects = "";
  for (let i = 0; i < bits.length; ) {
    if (bits[i] !== "1") {
      i++;
      continue;
    }
    let j = i;
    while (j < bits.length && bits[j] === "1") j++;
    rects += `<rect x="${i}" y="0" width="${j - i}" height="1"/>`;
    i = j;
  }
  const width = Math.min(3.5, bits.length * 0.025);
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${bits.length} 1" preserveAspectRatio="none" shape-rendering="crispEdges" style="display:block;margin:0 auto;width:${width}in;height:0.85in">${rects}</svg>`;
}

function addressLines(a: { address1: string; address2: string | null; city: string; province: string | null; zip: string }): string[] {
  return [a.address1, a.address2 ?? "", `${a.city}${a.province ? `, ${a.province}` : ""} ${a.zip}`].filter(Boolean);
}

function labelBody(d: DeliveryView, from: ShipFrom | null): string {
  const fromBlock = from
    ? `${esc(from.name)}<br>${addressLines(from).map(esc).join("<br>")}${from.phone ? `<br>${esc(from.phone)}` : ""}`
    : "Epic Steals";
  return `<section class="label">
  <header><span class="tag">LOCAL DELIVERY</span><span class="zip">${esc(d.zip)}</span></header>
  <div class="from"><small>FROM</small>${fromBlock}</div>
  <div class="to"><small>DELIVER TO</small>
    <p class="name">${esc(d.name)}</p>
    <p class="addr">${addressLines(d).map(esc).join("<br>")}</p>
    ${d.phone ? `<p class="phone">${esc(d.phone)}</p>` : ""}
    ${d.note ? `<p class="note">Note: ${esc(d.note)}</p>` : ""}
  </div>
  <div class="bar">${barcode(d.code)}<p class="code">${esc(d.code)} · Order ${esc(d.orderName)}</p></div>
  <div class="spacer"></div>
  <footer>Scan this label at the door before delivering · epic-steals.com</footer>
</section>`;
}

// One label per page, any number of deliveries in one print.
export function deliveryLabelsDocument(deliveries: DeliveryView[], from: ShipFrom | null): string {
  return `<!doctype html><html><head><meta charset="utf-8"><style>
@page { size: 4in 6in; margin: 0; }
* { box-sizing: border-box; margin: 0; padding: 0; }
html, body { width: 4in; }
body { font-family: Arial, Helvetica, sans-serif; color: #000; -webkit-print-color-adjust: exact; print-color-adjust: exact; }
.label { width: 4in; height: 6in; padding: 0.16in 0.18in; display: flex; flex-direction: column; gap: 0.08in; page-break-after: always; overflow: hidden; }
.label:last-child { page-break-after: auto; }
header { display: flex; justify-content: space-between; align-items: center; border-bottom: 3px solid #000; padding-bottom: 0.05in; }
.tag { background: #000; color: #fff; font-weight: 900; font-size: 15pt; padding: 0.03in 0.08in; letter-spacing: 1px; }
.zip { font-weight: 900; font-size: 26pt; }
small { display: block; font-size: 7pt; font-weight: 700; letter-spacing: 1px; color: #000; }
.from { font-size: 8pt; line-height: 1.25; }
.to { border: 2px solid #000; padding: 0.06in 0.1in; }
.name { font-size: 16pt; font-weight: 900; line-height: 1.1; }
.addr { font-size: 14pt; font-weight: 700; line-height: 1.2; margin-top: 0.02in; }
.phone { font-size: 11pt; margin-top: 0.03in; }
.note { font-size: 9pt; margin-top: 0.04in; font-style: italic; }
.bar { text-align: center; }
.code { font-size: 9pt; font-weight: 700; margin-top: 0.03in; }
.spacer { flex: 1; }
footer { font-size: 7pt; text-align: center; border-top: 1px solid #000; padding-top: 0.04in; }
</style></head><body>${deliveries.map((d) => labelBody(d, from)).join("")}</body></html>`;
}
