// Items eBay US won't let us list, caught from the manifest description so
// the Analyzer prices them at $0 instead of counting on revenue that can
// never happen. From eBay's medicine/medical devices policy (checked
// 2026-10-15, help/policies/prohibited-restricted-items/
// medicine-medical-devices-healthcare-products-policy):
//   - "Needles, with or without a disposable syringe" are prohibited.
//     Needleless syringes (oral, Luer-Lok tip) and lancets are not named.
//   - "Any medical device that requires a prescription can't be sold."
//   - COVID tests are banned even when over-the-counter.
// The Medical Supplies manifest (2026-10-15) was 274 of 1,135 boxes needle
// items plus 40 boxes of prescription catheters / Omnipod.
//
// Pure (no DB), so the Analyzer page labels rows from an evaluation that ran
// before this existed too.

const MEDICAL_NEEDLE = [
  /\binsulin syringes?\b/, // insulin syringes always come with the needle attached
  /\bpen ?ne+dd?les?\b/, // also catches the "Pen Neddle" misspelling seen on a manifest
  /\bpen ?tips\b|\bpentips\b/,
  /\bhypodermic\b/,
  /\b(safety|precision) ?glide\b/,
  /\btuberculin\b/,
  /\ballergy syringe/,
];

// "needle" alone is everywhere outside medical (sewing, knitting, pliers,
// record players), so it only counts next to medical context.
const NEEDLE_WORD = /\bne+dd?les?\b/;
const NEEDLE_MEDICAL_CONTEXT = /syringe|insulin|hypodermic|gauge|\b\d{2} ?g\b|\bbd\b|unifine|ultra ?fine|injection|sterile/;
const NEEDLE_NOT_MEDICAL = /sew|knit|crochet|embroider|tapestry|felting|craft|pliers|record|phono|stylus|turntable|pine|beading|upholster|quilt|darning|leather|bookbind|doll/;

const PRESCRIPTION = [
  /\brx only\b|\bprescription (only|required)\b/,
  // Urinary catheters (intermittent and external) are Rx-labeled in the
  // US. Accessories that just attach to one are fine.
  /\bcath(eter)?s?\b(?!.*\b(bags?|straps?|holders?|securement|stabiliz\w*|legband|valve)\b)|\bself.?cath\b|\bspee?d?icath\b|\bsel.?f?.?catch\b/,
  // No trailing word boundary: manifests run words together ("Omnipod5",
  // "Insulin Management SystemStarter Kit").
  /\bomnipod|\binsulin pump|\binsulin management system/,
  /\bdexcom\b|\bfreestyle libre\b|\bcontinuous glucose\b|\bcgm sensors?\b/,
  /\bcontact lens(es)?\b(?!.*\b(solution|case|cleaner|drops|saline|rinse)\b)/,
];

const COVID_TEST = /\b(covid|sars.?cov.?2?)\b.*\btests?\b|\btests?\b.*\b(covid|sars.?cov.?2?)\b/;

export function ebayBanReason(description: string): string | null {
  const d = description.toLowerCase();
  if (MEDICAL_NEEDLE.some((re) => re.test(d))) return "eBay bans needles";
  if (NEEDLE_WORD.test(d) && NEEDLE_MEDICAL_CONTEXT.test(d) && !NEEDLE_NOT_MEDICAL.test(d)) return "eBay bans needles";
  if (COVID_TEST.test(d)) return "eBay bans COVID tests";
  if (PRESCRIPTION.some((re) => re.test(d))) return "eBay bans prescription devices";
  return null;
}
