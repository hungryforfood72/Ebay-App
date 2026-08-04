# Finding eBay Category IDs

We don't have eBay Developer API access, so there's no Taxonomy API to query category IDs programmatically, and category ID lists you find online can be stale or wrong for the current eBay category tree. Getting one wrong risks a rejected or mis-filed listing, so don't guess. Find the real ID once per product type, then reuse it:

1. In Seller Hub (or the regular "Sell" flow), start listing one physical item of that type manually.
2. Use eBay's category search/picker and pick the most specific matching category.
3. Once selected, the category ID shows in the listing form (or in the page URL/dev tools network request as `CategoryID`).
4. Add it to the table below.

## Sticker Peak category map

| Product type | Category name on eBay | Category ID | Notes |
|---|---|---|---|
| Stickers | | | |
| Banners | | | |
| 3D prints | | | |
| Embroidery | | | |
| HTV apparel | | | |

Once this table has real IDs, the review page's "Category ID" field is just a lookup against this table (or a dropdown, if we build one) instead of free text.
