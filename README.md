# eBay Listing Tool

Internal Sticker Peak tool for turning shelf inventory into eBay listings. Two stages:

1. **Scan** (`/scan`) — mobile-first. Photos, UPC barcode scan, quantity, multi-pack info, expiration, shelf location. Saves straight to the database as soon as each item is submitted, no local-only state to lose.
2. **Review** (`/review`) — any device, desktop included. Edit title/description/price/category/condition, mark items ready, then download a File Exchange CSV for Seller Hub.

It's a normal website, not a native app: the same URL works in Safari on iPhone and Chrome on Android for scanning, and in any desktop browser for review/export.

## Status

Scan flow, review/export flow, UPC lookup, and Claude-drafted titles/descriptions are all wired up. Not yet done:
- eBay category ID mapping (enter manually for now — see `references/ebay-category-ids.md` for why, and how to fill it in)
- SFTP auto-upload (CSV download + manual Seller Hub upload for now)
- Nothing has been run against a live Supabase/Cloudinary/Anthropic setup yet — `next build` passes, but this still needs a real end-to-end test once credentials are in place

## Local setup

```bash
npm install
```

Copy `.env.example` to `.env.local` and fill in:

- `DATABASE_URL` / `DIRECT_URL` — from a Supabase project (Project Settings → Database → Connection string). Use the pooled connection (port 6543) for `DATABASE_URL`, the direct connection (port 5432) for `DIRECT_URL`.
- `CLOUDINARY_*` — from your Cloudinary dashboard (Settings → Access Keys).
- `ANTHROPIC_API_KEY` — from console.anthropic.com (a separate login from claude.ai). Powers the "Generate AI draft" button on the review page.
- `UPC_LOOKUP_API_KEY` — not needed yet, UPC lookups use UPCitemdb's keyless trial tier (100/day) until volume requires a paid key.

Push the schema to your Supabase database:

```bash
npx prisma migrate dev --name init
```

Run the app:

```bash
npm run dev
```

## Deploying

Deploy to Vercel, pointed at this folder. Add the same env vars from `.env.local` as Vercel project environment variables. Turn on **Vercel Deployment Protection** (Project Settings → Deployment Protection → password) so the site isn't a public URL with no lock on it, since it holds inventory and pricing data. Note: `@zxing/library` currently warns it wants Node 24, Vercel's Node runtime version can be set in Project Settings if the build complains.

## Notes on the eBay File Exchange CSV

`src/lib/csv.ts` generates a minimal "Add" format (Action, SKU, Category, Title, Description, PicURL, Quantity, StartPrice, ConditionID). Before your first real upload, download an actual template CSV from Seller Hub for your category and compare headers, File Exchange's expected columns can vary slightly by category.
