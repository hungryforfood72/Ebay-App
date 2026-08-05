# Shipping, Returns & Payment Setup

Confirmed against Cristian's real "Create Ebay Listings Upload-CSV" template
(the live "Add" listing template, not the Drafts one) — not guessed.

## Business Policies, not inline CSV fields

eBay's individual `ShippingType`, `ShippingService-1:Option`,
`ReturnsAcceptedOption`, etc. columns require exact enum values that are easy
to get wrong. The template also has `ShippingProfileName`,
`ReturnProfileName`, and `PaymentProfileName` columns — these reference
**Business Policies** set up once in Seller Hub's UI (Account → Business
Policies), where eBay's own dropdowns guarantee correct values. Per eBay's
own docs: if you use the profile-name columns, leave the individual
shipping/return/payment columns blank. That's what this app does.

### One-time setup (Cristian, in eBay Seller Hub)

Everything ships free for now (decided 2026-08-04 to keep things simple), so
only one shipping policy is needed:

1. **Payment policy** — one is usually enough.
2. **Return policy** — your standard return window/terms.
3. **Shipping policy** — Free, Flat rate $0, USPS Ground Advantage,
   Alaska/Hawaii excluded (set the exclusion in the policy itself, not
   per-listing).

Policy names are case-sensitive and must match exactly what's in the app's
env vars below.

### Env vars (`.env.local` and Vercel)

```
EBAY_SHIPPING_POLICY_FREE=""  # name of the Free Shipping policy
EBAY_RETURN_POLICY_NAME=""
EBAY_PAYMENT_POLICY_NAME=""
EBAY_LISTING_ZIP="60620"
```

`chargeForShipping` still exists on the item record and the CSV logic
(`src/lib/csv.ts`) if a calculated-shipping option is wanted again later, it
just isn't wired up to anything right now — every export uses the Free
Shipping policy regardless.

## Real upload error hit and fixed (2026-08-05)

First real upload attempt failed: `Error 37 — Input data for tag
<Item.AutoPay> is invalid or missing`. Root cause per eBay community/support
threads:

1. **Wrong field.** For Managed Payments sellers, the correct column is
   `AutoPay` with value `true` (lowercase) — not `ImmediatePayRequired`,
   which is what the downloaded template used and what we'd been sending.
2. **eBay's own guidance:** leaving a bunch of template columns present-but-
   blank can cause spurious errors reported against an unrelated tag. Their
   fix is to delete columns you're not using rather than leave them empty.

Both are now fixed in `src/lib/csv.ts` — switched to `AutoPay=true`, and
trimmed the CSV down to only the columns we actually populate (dropped
StoreCategory, Subtitle, Relationship*, C:Style, C:MPN, C:California Prop 65
Warning, C:Country/Region of Manufacture, BuyItNowPrice, the individual
ShippingService/Returns fields, AdditionalDetails, C:Item Length/Width/
Height).

**One calculated risk in that trim, worth watching on the next upload
attempt:** `DispatchTimeMax` and `ReturnsAcceptedOption` were both marked
`*` (required) in the downloaded template, but we dropped them along with
the rest on the theory that a Business Policy (ShippingProfileName/
ReturnProfileName) satisfies the requirement even though the blank template
still marks the raw field required. If the next upload complains about
either of those specifically, that theory was wrong — add the column back
with an explicit value (e.g. `DispatchTimeMax=1` for 1-day handling,
`ReturnsAcceptedOption=ReturnsAccepted`).

## Still worth verifying

- **Weight and calculated shipping.** This template has no explicit
  package-weight column for eBay's shipping calculator — only `C:Item
  Weight`, which is an *item specific* (a buyer-facing spec, e.g. "1 lb 8
  oz"), not necessarily what feeds a calculated-shipping cost engine. Not
  urgent right now since everything's free shipping (flat $0), but relevant
  if calculated shipping comes back.
- **Category ID** — now sourced from the imported EbayCategory table (see
  references/ebay-category-ids.md), not a guess.
