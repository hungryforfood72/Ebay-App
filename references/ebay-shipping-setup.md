# Shipping in the File Exchange CSV

The app captures everything needed for shipping (charge-for-shipping toggle,
box size, weight) and writes it into the CSV, but I'm not fully confident in
three specific values without checking them against a real downloaded
File Exchange template — verify these before your first real shipping-enabled
upload:

1. **`ShippingService-1:Option` value for USPS Ground Advantage.** Currently
   set to `USPSGroundAdvantage` in `src/lib/csv.ts`. Ground Advantage is a
   relatively new USPS service (it replaced First Class Package/Parcel
   Select Ground), so eBay's exact internal service code for it in File
   Exchange is worth double-checking — download a template from Seller Hub
   for a listing using that service and compare.

2. **`ExcludeShipToLocation` format for Alaska/Hawaii.** Currently set to
   the literal string `Alaska,Hawaii`. eBay may expect a different format
   (e.g. region codes). Check a template.

3. **`PackageSize`.** This isn't a standard eBay column name — it's a
   placeholder holding whatever text you type into the Box Size field on
   the review page (e.g. "Small 6x4x2"). eBay's File Exchange actually
   wants either a package-type enum (envelope/box presets) or explicit
   `PackageLength`/`PackageWidth`/`PackageDepth` columns in inches. Once you
   know which your account's template expects, either:
   - swap `PackageSize` for those dimension columns and start storing real
     L×W×H per box size, or
   - map your box size labels to eBay's package-type enum values.

## How the shipping logic works

- **Unchecked "Charge for shipping"** → `ShippingType=Flat`, cost `$0.00`
  (free to the buyer). Weight and box size are still sent, since you're
  still shipping a real package and want eBay/USPS pricing info accurate
  even when you're absorbing the cost yourself.
- **Checked** → `ShippingType=Calculated`, cost left blank (eBay computes
  it at listing/purchase time from weight + package + buyer zip).
- **Alaska/Hawaii** are always excluded — this is a blanket store policy,
  not a per-item toggle.

Box sizes are free-text with autocomplete from what you've typed before
(same pattern as shelf locations on the scan page) — there's no preset
list to maintain, it just remembers what you use.
