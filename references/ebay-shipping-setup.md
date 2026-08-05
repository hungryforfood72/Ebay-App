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

1. **Payment policy** — one is usually enough.
2. **Return policy** — your standard return window/terms.
3. **Two shipping policies**:
   - **Free Shipping** — Flat rate, $0, USPS Ground Advantage, Alaska/Hawaii
     excluded (set the exclusion in the policy itself, not per-listing).
   - **Calculated Shipping** — Calculated, USPS Ground Advantage,
     Alaska/Hawaii excluded.

Policy names are case-sensitive and must match exactly what's in the app's
env vars below.

### Env vars (`.env.local` and Vercel)

```
EBAY_SHIPPING_POLICY_FREE=""       # name of the Free Shipping policy
EBAY_SHIPPING_POLICY_CALCULATED="" # name of the Calculated Shipping policy
EBAY_RETURN_POLICY_NAME=""
EBAY_PAYMENT_POLICY_NAME=""
EBAY_LISTING_ZIP="60620"
```

The review page's "Charge for shipping" checkbox picks between the two
shipping policy names — checked = Calculated, unchecked = Free.

## Still worth verifying on your first real upload

- **Weight and calculated shipping.** This template has no explicit
  package-weight column for eBay's shipping calculator — only `C:Item
  Weight`, which is an *item specific* (a buyer-facing spec, e.g. "1 lb 8
  oz"), not necessarily what feeds the calculated-shipping cost engine.
  Whether a Calculated shipping policy needs weight declared somewhere else
  (e.g. set per-category default in the policy, or via the eBay listing UI
  after upload) isn't confirmed. Test one calculated-shipping listing and
  check that eBay actually computed a sane cost before doing a batch.
- **Item Length/Width/Height** are left blank — we only collect a free-text
  box size label (with autocomplete), not structured dimensions. Not needed
  unless a category requires them.
- **Category ID** — Cristian has eBay's own category reference file; once
  loaded, that becomes the source of truth over the AI-search/CategoryRule
  system for anything it covers.
