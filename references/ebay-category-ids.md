# eBay Category IDs

Solved properly as of 2026-08-04: Cristian pulled eBay's own official
category export (`CR_26.2_US_Category_Changes.csv`, ~20,571 categories with
real current IDs and full breadcrumb paths) and it's imported into the
`EbayCategory` table. This replaced guessing/scraping entirely.

## How category lookup works now, in order

1. **Saved `CategoryRule` keyword match** — instant, free. Something we've
   picked before for this product type.
2. **Local search + AI pick** — search `EbayCategory` (the real eBay tree)
   for candidates matching words in the item's title, then one quick
   tool-free Claude call picks the best match from those real candidates.
   No web search involved, so no timeout risk — typically 2-5 seconds.
   Verified live: "Custom Vinyl Die-Cut Sticker Pack..." correctly resolved
   to 159889 (Decals, Stickers & Vinyl Art) in ~2.5s.
3. **AI web search** — only reached if step 2 finds zero local candidates
   (very rare now, given the local tree covers ~20K categories). Same
   slow/unpredictable web-search approach as before, kept only as a
   last resort.

Every path that finds a category auto-saves a `CategoryRule` so the same
product type never needs any of this again.

## Manual search

The review page also has a live search box next to the Category ID field
(hits `GET /api/ebay-categories/search?q=...`) — search by real category
name instead of guessing an ID.

## Re-importing / updating the category tree

eBay periodically publishes updated category-changes exports. To refresh:

1. Download the current CSV from eBay (Seller Hub → category changes, or
   the direct static URL if you have it).
2. The import script that parsed the last one is not checked into the repo
   (it was a one-off scratch script) — ask Claude to re-parse a new CSV the
   same way: split on commas respecting quoted fields, the category name is
   the last non-empty column before the numeric Category ID column, build
   the breadcrumb path from nesting depth, then bulk-upsert into
   `EbayCategory` (`ON CONFLICT (id) DO UPDATE`).
