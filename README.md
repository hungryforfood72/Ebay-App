# eBay Listing Tool

Internal Sticker Peak tool for turning shelf inventory into eBay listings. Two stages:

1. **Scan** (`/scan`) — mobile-first. Photos, UPC barcode scan, quantity, multi-pack info, expiration, shelf location. Saves straight to the database as soon as each item is submitted, no local-only state to lose.
2. **Review** (`/review`) — any device, desktop included. Edit title/description/price/category/condition, mark items ready, then download a File Exchange CSV for Seller Hub.

It's a normal website, not a native app: the same URL works in Safari on iPhone and Chrome on Android for scanning, and in any desktop browser for review/export.

## Status

Deployed and running on Vercel with a live Supabase database. Scan flow, review/export flow, UPC lookup, Claude-drafted titles/descriptions, and a self-learning eBay category ID lookup (see below) are all wired up. Not yet done:
- SFTP auto-upload (CSV download + manual Seller Hub upload for now)
- Full end-to-end test on a phone (scan → review → export) still pending

## eBay category IDs

No eBay API access means no Taxonomy API, and this app doesn't scrape eBay's site at runtime (against their terms, fragile). Instead, category IDs are looked up once per product type and saved as a `CategoryRule` (keyword → category ID) in the database. The review page matches an item's title against saved keywords and auto-suggests the category; anything set manually can be saved as a new rule with one click ("Remember this category"). See `references/ebay-category-ids.md` for the running log and how to find a new ID when one's needed.

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
npx prisma db push
```

(We use `db push` instead of `migrate dev` here — Supabase's pooled connection doesn't allow Prisma to create the shadow database `migrate dev` needs. `prisma/migrations/` still has the initial migration for reference, but schema changes since then are applied directly.)

Run the app:

```bash
npm run dev
```

## Deploying

Deploy to Vercel, pointed at this folder. Add the same env vars from `.env.local` as Vercel project environment variables. Turn on **Vercel Deployment Protection** (Project Settings → Deployment Protection → password) so the site isn't a public URL with no lock on it, since it holds inventory and pricing data. Note: `@zxing/library` currently warns it wants Node 24, Vercel's Node runtime version can be set in Project Settings if the build complains.

## Notes on the eBay File Exchange CSV

`src/lib/csv.ts` generates a minimal "Add" format (Action, SKU, Category, Title, Description, PicURL, Quantity, StartPrice, ConditionID). Before your first real upload, download an actual template CSV from Seller Hub for your category and compare headers, File Exchange's expected columns can vary slightly by category.
