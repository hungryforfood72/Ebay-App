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
const BUILT_IN: BlockedPhrase[] = [{ phrase: "Ultra Sheer", when: "Neutrogena" }];

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
  return result === text ? text : result.replace(/ {2,}/g, " ").replace(/ +([,.;:!?])/g, "$1").trim();
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
// the title with one word left out at a time, and see which removals let it
// through. A blocked phrase like "Ultra Sheer" shows up as both words; the
// brand ("Neutrogena") often shows up too, since the block needs both, so
// the brand is kept and only the rest is removed. Learned phrases are saved
// for next time. Returns null when the title isn't the problem (the block
// is in the description, or it's not a words problem at all), leaving it
// for a person.
export async function findBlockedPhrases(item: ItemForEbayPublish): Promise<BlockedPhrase[] | null> {
  const title = item.finalTitle;
  if (!(await isBlockedByWordFilter(item, title, PLAIN_DESCRIPTION))) return null;

  const words = title.split(/\s+/).filter(Boolean);
  const without = (skip: Set<number>) => words.filter((_, i) => !skip.has(i)).join(" ");
  const stillBlocked = await inBatches(words.map((_, i) => () => isBlockedByWordFilter(item, without(new Set([i])), PLAIN_DESCRIPTION)));
  const culprits = words.map((_, i) => i).filter((i) => !stillBlocked[i]);
  if (culprits.length === 0) return null;

  const brand = item.itemSpecifics?.brand?.toLowerCase() ?? "";
  const brandWords = new Set(brand.split(/\s+/).filter(Boolean));
  const nonBrand = culprits.filter((i) => !brandWords.has(words[i].toLowerCase()));
  const remove = nonBrand.length > 0 ? nonBrand : culprits;
  if (await isBlockedByWordFilter(item, without(new Set(remove)), PLAIN_DESCRIPTION)) return null;

  // Back-to-back words are one phrase ("Ultra Sheer"), not two.
  let runs: number[][] = [];
  remove.forEach((i, n) => {
    if (n > 0 && remove[n - 1] === i - 1) runs[runs.length - 1].push(i);
    else runs.push([i]);
  });
  // eBay can block a whole product name, so taking out any one piece of it
  // gets through: "Neutrogena Ultra Sheer ... SPF 70 3oz" (the recalled
  // spray's name) passed with either "Ultra Sheer" or "70 3oz" gone,
  // confirmed live 2026-10-15. Keep every piece the title can keep, trying
  // sizes and counts first since those are facts buyers search on.
  const hasNumber = (run: number[]) => run.some((i) => /\d/.test(words[i]));
  const order = [...runs.filter(hasNumber), ...runs.filter((r) => !hasNumber(r))];
  for (const run of order) {
    if (runs.length === 1) break;
    const rest = runs.filter((r) => r !== run);
    if (!(await isBlockedByWordFilter(item, without(new Set(rest.flat())), PLAIN_DESCRIPTION))) runs = rest;
  }
  const brandInTitle = brand && remove !== culprits && title.toLowerCase().includes(brand);
  const found = runs.map((run) => ({
    phrase: run.map((i) => words[i]).join(" "),
    ...(brandInTitle ? { when: item.itemSpecifics!.brand } : {}),
  }));
  await learnPhrases(found);
  console.log(`[blockedWords] learned ${JSON.stringify(found)} from "${title}"`);
  return found;
}
