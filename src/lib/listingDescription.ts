// How a listing description looks on eBay (Cristian, 2026-10-25: "make it
// look nicer, not all bunched up"). The description is written and edited as
// plain text with a light structure the AI draft follows:
//
//   One or two sentences on what the buyer gets.
//
//   What's included:
//   - 2 boxes, 10 pouches each (20 total)
//
//   Details:
//   - Brand: ConvaTec
//
// A short line ending in ":" is a heading, lines starting with "- " are
// bullets, blank lines separate paragraphs. Older descriptions (one
// paragraph) and ones that are already HTML still work. No logo banner on
// purpose: most eBay buyers are on the app, where heavy templates get
// squeezed or hidden behind "See full description". Inline styles only,
// since eBay strips <style> blocks in places. Client-safe: the Review page
// previews it.

const FONT = "Arial,Helvetica,sans-serif";
const S = {
  wrap: `font-family:${FONT};font-size:15px;line-height:1.6;color:#222;max-width:820px;margin:0 auto;`,
  p: "margin:0 0 12px;",
  h: "font-size:17px;font-weight:bold;color:#111;margin:20px 0 6px;padding-bottom:4px;border-bottom:1px solid #e5e7eb;",
  ul: "margin:0 0 12px;padding-left:22px;",
  li: "margin:0 0 4px;",
  box: "margin-top:24px;padding:14px 18px;background:#f5f6f8;border-radius:8px;font-size:14px;",
  boxTitle: "margin:0 0 6px;font-weight:bold;color:#111;",
};

const FOOTER_TITLE = "Buying from us";

function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

const BULLET = /^\s*[-•*]\s+/;
const isHtml = (text: string) => /<[a-z][^>]*>/i.test(text);

function isHeading(line: string): boolean {
  const t = line.trim();
  return t.endsWith(":") && t.length <= 40 && !BULLET.test(t);
}

// The description itself as HTML (no wrapper, no footer). Used for eBay
// inside the template, and as-is for the Shopify store.
export function descriptionBodyHtml(text: string): string {
  if (!text.trim()) return "";
  if (isHtml(text)) return text;
  const out: string[] = [];
  let bullets: string[] = [];
  let para: string[] = [];
  const flushBullets = () => {
    if (bullets.length) out.push(`<ul style="${S.ul}">${bullets.map((b) => `<li style="${S.li}">${b}</li>`).join("")}</ul>`);
    bullets = [];
  };
  const flushPara = () => {
    if (para.length) out.push(`<p style="${S.p}">${para.join("<br>")}</p>`);
    para = [];
  };
  for (const raw of text.replace(/\r\n/g, "\n").split("\n")) {
    const line = raw.trim();
    if (!line) {
      flushBullets();
      flushPara();
    } else if (BULLET.test(line)) {
      flushPara();
      bullets.push(escapeHtml(line.replace(BULLET, "")));
    } else if (isHeading(line)) {
      flushBullets();
      flushPara();
      out.push(`<h3 style="${S.h}">${escapeHtml(line.slice(0, -1))}</h3>`);
    } else {
      flushBullets();
      para.push(escapeHtml(line));
    }
  }
  flushBullets();
  flushPara();
  return out.join("");
}

// The full eBay description: the text, then a short note on buying from us.
export function ebayDescriptionHtml(item: { finalDescription: string | null; localPickupOnly?: boolean }): string {
  const text = item.finalDescription ?? "";
  // Already laid out (a listing restored from the eBay backup, or pulled
  // back from eBay): wrapping it again would show the note twice.
  if (text.includes(`>${FOOTER_TITLE}<`)) return text;
  const body = descriptionBodyHtml(text);
  const notes = [
    item.localPickupOnly
      ? "Local pickup only, no shipping."
      : "Free shipping with USPS Ground Advantage, packed with care.",
    "The photos are of the actual item, not stock images.",
    "Questions? Send us a message and we'll help.",
  ];
  return (
    `<div style="${S.wrap}">${body}` +
    `<div style="${S.box}"><p style="${S.boxTitle}">${FOOTER_TITLE}</p>` +
    `<ul style="${S.ul}margin-bottom:0;">${notes.map((n) => `<li style="${S.li}">${escapeHtml(n)}</li>`).join("")}</ul></div>` +
    `</div>`
  );
}
