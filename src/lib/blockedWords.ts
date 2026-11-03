import { prisma } from "@/lib/prisma";
import { isBlockedByWordFilter, type ItemForEbayPublish } from "@/lib/ebay";

// Words eBay's listing filter blocks outright ("The item cannot be listed or
// modified. The title and/or description may contain improper words").
// `when`, if set, limits the block to listings that also mention that word,
// usually the brand.
export type BlockedPhrase = { phrase: string; when?: string };

// "Ultra Sheer" next to Neutrogena trips the recall filter for the 2021
// benzene aerosol recall, even on lotions and serums that were never
// recalled (confirmed 2026-10-08 with VerifyAddFixedPriceItem: the same
// listing goes through without those two words). Cristian's call: list the
// non-recalled ones without the words.
// "FDA registered" and "FDA approved" in a description block any listing
// (confirmed 2026-11-02 on Flex period cups: those were the only lines in
// the way; "FDA cleared", "FDA registered facility" and plain "FDA" pass).
// The title-only search below can't find these, since drafts put them in
// the description.
const BUILT_IN: BlockedPhrase[] = [
  { phrase: "Ultra Sheer", when: "Neutrogena" },
  { phrase: "FDA registered" },
  { phrase: "FDA approved" },
];

// Phrases found automatically by findBlockedPhrases, so the next draft or
// publish strips them before eBay ever sees them.
const LEARNED_KEY = "ebay.blockedPhrases";

export async function getBlockedPhrases(): Promise<BlockedPhrase[]> {
  const row = await prisma.appSetting.findUnique({ where: { key: LEARNED_KEY } });
  let learned: BlockedPhrase[] = [];
  try {
    learned = row ? (JSON.parse(row.value) as BlockedPhrase[]) : [];
  } catch {
    // A hand-edited, broken value shouldn't stop publishing.
  }
  return [...BUILT_IN, ...learned];
}

async function learnPhrases(phrases: BlockedPhrase[]): Promise<void> {
  const row = await prisma.appSetting.findUnique({ where: { key: LEARNED_KEY } });
  let learned: BlockedPhrase[] = [];
  try {
    learned = row ? (JSON.parse(row.value) as BlockedPhrase[]) : [];
  } catch {}
  const same = (a: BlockedPhrase, b: BlockedPhrase) =>
    a.phrase.toLowerCase() === b.phrase.toLowerCase() && (a.when ?? "").toLowerCase() === (b.when ?? "").toLowerCase();
  for (const p of phrases) if (!learned.some((l) => same(l, p))) learned.push(p);
  const value = JSON.stringify(learned);
  await prisma.appSetting.upsert({ where: { key: LEARNED_KEY }, create: { key: LEARNED_KEY, value }, update: { value } });
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function phrasePattern(phrase: string): RegExp {
  const words = phrase.trim().split(/\s+/).map(escapeRegex);
  return new RegExp(`(?<![\\w-])${words.join("[\\s-]+")}(?![\\w-])[ \\t]*`, "gi");
}

export function removeBlockedPhrases(text: string, phrases: BlockedPhrase[]): string {
  let result = text;
  for (const { phrase, when } of phrases) {
    if (when && !phrasePattern(when).test(result)) continue;
    result = result.replace(phrasePattern(phrase), "");
  }
  if (result === text) return text;
  // A bullet that was only the phrase ("- FDA registered") goes; one that
  // started with it ("- FDA registered, reusable") keeps the rest.
  return result
    .split("\n")
    .map((line) => line.replace(/^(\s*[-•*]\s*)[,;]\s*/, "$1"))
    .filter((line) => !/^\s*[-•*]\s*$/.test(line))
    .join("\n")
    .replace(/ {2,}/g, " ")
    .replace(/ +([,.;:!?])/g, "$1")
    .trim();
}

// Runs `checks` a few at a time: each one is a real eBay call, and a long
// title would otherwise fire 15 at once.
async function inBatches<T>(checks: (() => Promise<T>)[], size = 5): Promise<T[]> {
  const results: T[] = [];
  for (let i = 0; i < checks.length; i += size) {
    results.push(...(await Promise.all(checks.slice(i, i + size).map((c) => c()))));
  }
  return results;
}

const PLAIN_DESCRIPTION = "See photos for details.";

// eBay never says WHICH words it objects to. This finds them the same way
// they were found by hand on 2026-10-08: ask eBay's free verify call about
// the text with one word left out at a time, and see which removals let it
// through. A blocked phrase like "Ultra Sheer" shows up as both words; the
// brand ("Neutrogena") often shows up too, since the block needs both, so
// the brand is kept and only the rest is removed. null when no set of words
// in `text` explains the block.
async function phrasesIn(
  text: string,
  blocked: (text: string) => Promise<boolean>,
  brandName: string
): Promise<BlockedPhrase[] | null> {
  const words = text.split(/\s+/).filter(Boolean);
  const without = (skip: Set<number>) => words.filter((_, i) => !skip.has(i)).join(" ");
  const stillBlocked = await inBatches(words.map((_, i) => () => blocked(without(new Set([i])))));
  const culprits = words.map((_, i) => i).filter((i) => !stillBlocked[i]);
  if (culprits.length === 0) return null;

  const brand = brandName.toLowerCase();
  const brandWords = new Set(brand.split(/\s+/).filter(Boolean));
  const nonBrand = culprits.filter((i) => !brandWords.has(words[i].toLowerCase()));
  const remove = nonBrand.length > 0 ? nonBrand : culprits;
  if (await blocked(without(new Set(remove)))) return null;

  // Back-to-back words are one phrase ("Ultra Sheer"), not two.
  let runs: number[][] = [];
  remove.forEach((i, n) => {
    if (n > 0 && remove[n - 1] === i - 1) runs[runs.length - 1].push(i);
    else runs.push([i]);
  });
  // eBay can block a whole product name, so taking out any one piece of it
  // gets through: "Neutrogena Ultra Sheer ... SPF 70 3oz" (the recalled
  // spray's name) passed with either "Ultra Sheer" or "70 3oz" gone,
  // confirmed live 2026-10-15. Keep every piece the text can keep, trying
  // sizes and counts first since those are facts buyers search on.
  const hasNumber = (run: number[]) => run.some((i) => /\d/.test(words[i]));
  const order = [...runs.filter(hasNumber), ...runs.filter((r) => !hasNumber(r))];
  for (const run of order) {
    if (runs.length === 1) break;
    const rest = runs.filter((r) => r !== run);
    if (!(await blocked(without(new Set(rest.flat()))))) runs = rest;
  }
  const brandInText = brand && remove !== culprits && text.toLowerCase().includes(brand);
  return runs.map((run) => ({
    phrase: run.map((i) => words[i]).join(" "),
    ...(brandInText ? { when: brandName } : {}),
  }));
}

// Finds the words eBay's filter blocks in this listing's title, or else in
// one line of its description (2026-11-02: an "FDA registered" bullet on
// Flex period cups, which the title-only search couldn't find), and saves
// them for next time. Returns null when neither explains the block (it's
// spread over several lines, or it's not a words problem at all), leaving
// it for the fix agent or a person.
export async function findBlockedPhrases(item: ItemForEbayPublish): Promise<BlockedPhrase[] | null> {
  const title = item.finalTitle;
  const brandName = item.itemSpecifics?.brand ?? "";
  let found: BlockedPhrase[];
  if (await isBlockedByWordFilter(item, title, PLAIN_DESCRIPTION)) {
    const inTitle = await phrasesIn(title, (t) => isBlockedByWordFilter(item, t, PLAIN_DESCRIPTION), brandName);
    if (!inTitle) return null;
    found = inTitle;
  } else {
    const description = item.finalDescription;
    if (!description || !(await isBlockedByWordFilter(item, title, description))) return null;
    const lines = description.split("\n");
    const withLine = (i: number, line: string) => lines.map((l, j) => (j === i ? line : l)).join("\n");
    const candidates = lines.map((_, i) => i).filter((i) => lines[i].trim());
    const stillBlocked = await inBatches(candidates.map((i) => () => isBlockedByWordFilter(item, title, withLine(i, ""))));
    const culpritLines = candidates.filter((_, n) => !stillBlocked[n]);
    if (culpritLines.length === 0) return null;
    found = [];
    for (const i of culpritLines) {
      const inLine = await phrasesIn(lines[i], (l) => isBlockedByWordFilter(item, title, withLine(i, l)), brandName);
      if (!inLine) return null;
      found.push(...inLine);
    }
  }
  await learnPhrases(found);
  console.log(`[blockedWords] learned ${JSON.stringify(found)} from ${item.sku}`);
  return found;
}
