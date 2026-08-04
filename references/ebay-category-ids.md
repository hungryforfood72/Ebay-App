# eBay Category IDs

We don't have eBay Developer API access, so there's no Taxonomy API to query
category IDs, and this app doesn't scrape eBay's site to look them up
automatically (against their terms, and fragile). Instead, category IDs are
looked up once per product type and saved as a `CategoryRule` (keyword ->
category ID), so the review page auto-suggests one once it's been seen
before. The rules live in the database — this file is just a running log of
what's been added and where each ID came from.

## How a new category gets added

1. On the review page, set the Category ID field manually (see "finding an
   ID" below).
2. Type a keyword in the "Remember this category by" box (e.g. `hair dye`)
   and click "Remember this category."
3. Any future item whose title contains that keyword auto-suggests it.

## Finding an ID for something new

Ask Claude to look it up (fastest — searches eBay's live `ebay.com/b/...`
browse URLs, which embed the real current category ID), or find it yourself:

1. Search the product on ebay.com, click into the most specific matching
   category in the left sidebar filter.
2. The category ID is the number in the URL (`&_sacat=123456` on search
   pages, or the numeric segment in `ebay.com/b/Name/123456/bn_...` browse
   URLs).

## Rules added so far

| Keyword | Category | ID | Source |
|---|---|---|---|
| hair dye / hair color | Hair Color Products | 31412 | ebay.com/b/Hair-Color-Products/31412 |
| toys | Toys & Hobbies (broad — pick a more specific subcategory if the item warrants it) | 220 | ebay.com/b/Best-Toys-Hobbies/220 |
| craft stickers | Craft Stickers | 11794 | ebay.com/b/Craft-Stickers/11794 |
| vinyl stickers / decals | Décor Decals, Stickers & Vinyl Art | 159889 | ebay.com/b/Decor-Decals-Stickers-Vinyl-Art/159889 |

Sticker Peak's own vinyl/die-cut stickers are probably category 159889
(Decor Decals, Stickers & Vinyl Art) rather than 11794 (Craft Stickers, more
scrapbooking-oriented) — worth confirming which fits better once you're
listing your own stickers rather than resale inventory, then saving it as a
rule with keyword `sticker`.
