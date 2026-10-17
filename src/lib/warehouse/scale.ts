// Reading a USB postal scale (DYMO M25 / M10, or any HID "point of sale"
// scale) from the station page through WebHID. This file is just the pure
// parsing and formatting, so it can be tested without a scale; the device
// handling lives in src/app/station/[id]/useScale.ts. Client-safe.
//
// HID POS scale data report (report id 3 on the DYMOs):
//   byte 0  report id (3)
//   byte 1  status   1 fault, 2 stable at zero, 3 in motion, 4 stable,
//                    5 under zero, 6 over weight, 7 needs calibration,
//                    8 needs re-zeroing
//   byte 2  unit     2 grams, 3 kilograms, 11 ounces, 12 pounds (others rare)
//   byte 3  exponent signed int8, weight = raw * 10^exponent
//   byte 4-5 raw weight, little-endian
// WebHID usually hands the report id over separately (event.reportId) and
// leaves it out of event.data, so the parser accepts both shapes.

// USB ids for the filters passed to navigator.hid.requestDevice. The DYMO
// ids first; the usage page catches other brands' HID scales.
export const DYMO_VENDOR_ID = 0x0922;
export const DYMO_M25_PRODUCT_ID = 0x8004;
export const DYMO_M10_PRODUCT_ID = 0x8003;
export const HID_POS_SCALE_USAGE_PAGE = 0x8d;

export const SCALE_HID_FILTERS = [
  { vendorId: DYMO_VENDOR_ID, productId: DYMO_M25_PRODUCT_ID },
  { vendorId: DYMO_VENDOR_ID, productId: DYMO_M10_PRODUCT_ID },
  { usagePage: HID_POS_SCALE_USAGE_PAGE },
];

export type ScaleStatus =
  | "fault"
  | "zero"
  | "moving"
  | "stable"
  | "under_zero"
  | "over_weight"
  | "needs_calibration"
  | "needs_rezero";

export type ScaleReading = {
  status: ScaleStatus;
  // Ounces, rounded to 0.01 (what Station.weightOz stores). null when the
  // scale can't give a usable number (fault, under zero, over weight...).
  weightOz: number | null;
  // The scale says the number has settled. Only "zero" and "stable" are.
  stable: boolean;
};

const STATUS_BY_CODE: Record<number, ScaleStatus> = {
  1: "fault",
  2: "zero",
  3: "moving",
  4: "stable",
  5: "under_zero",
  6: "over_weight",
  7: "needs_calibration",
  8: "needs_rezero",
};

const GRAMS_PER_OUNCE = 28.349523125;

// How many ounces one of each HID weight unit is. Units not listed here
// (carats, taels, grains...) aren't something a shipping scale gets set to;
// a reading in one of them comes back with weightOz null.
const OUNCES_PER_UNIT: Record<number, number> = {
  1: 0.001 / GRAMS_PER_OUNCE, // milligrams
  2: 1 / GRAMS_PER_OUNCE, // grams
  3: 1000 / GRAMS_PER_OUNCE, // kilograms
  10: 1.0971428571, // troy ounces
  11: 1, // ounces
  12: 16, // pounds
};

const SCALE_REPORT_ID = 3;

function toBytes(data: DataView | ArrayLike<number>): number[] {
  if (data instanceof DataView) {
    return Array.from({ length: data.byteLength }, (_, i) => data.getUint8(i));
  }
  return Array.from(data, (b) => b & 0xff);
}

// Turns one input report into a reading. Pass WebHID's event.reportId as
// reportId when there is one. Returns null for reports that aren't a weight
// reading (wrong length, unknown status), so callers can just skip them.
export function parseScaleReport(data: DataView | ArrayLike<number>, reportId?: number): ScaleReading | null {
  let bytes = toBytes(data);
  // With no separate report id (or id 0 = "this device has no report
  // ids"), a 6+ byte report starting with 3 still has the id at the front.
  if ((reportId === undefined || reportId === 0) && bytes.length >= 6 && bytes[0] === SCALE_REPORT_ID) {
    bytes = bytes.slice(1);
  }
  if (bytes.length < 5) return null;

  const [statusCode, unitCode, expByte, lo, hi] = bytes;
  const status = STATUS_BY_CODE[statusCode];
  if (!status) return null;

  const exponent = expByte > 127 ? expByte - 256 : expByte;
  const raw = lo | (hi << 8);
  const perUnit = OUNCES_PER_UNIT[unitCode];

  if (status === "zero") return { status, weightOz: 0, stable: true };
  if (status !== "stable" && status !== "moving") return { status, weightOz: null, stable: false };
  if (perUnit === undefined) return { status, weightOz: null, stable: false };

  const ounces = raw * Math.pow(10, exponent) * perUnit;
  return { status, weightOz: Math.round(ounces * 100) / 100, stable: status === "stable" };
}

// What to show (and tell the lister) when a reading has no usable weight.
export function scaleStatusMessage(status: ScaleStatus): string | null {
  switch (status) {
    case "fault":
      return "The scale reports a fault. Turn it off and on again.";
    case "under_zero":
      return "The scale reads below zero. Take everything off and press Zero.";
    case "over_weight":
      return "Too heavy for the scale.";
    case "needs_calibration":
      return "The scale needs calibrating. See the DYMO manual.";
    case "needs_rezero":
      return "Take everything off the scale and press Zero.";
    default:
      return null;
  }
}

// "30.0 oz". One decimal is what the DYMO resolves to in ounce mode.
export function formatOunces(oz: number): string {
  return `${oz.toFixed(1)} oz`;
}

// "1 lb 14.0 oz", or just "14.0 oz" under a pound.
export function formatPoundsOunces(oz: number): string {
  // Round first so 15.96 oz shows as "1 lb 0.0 oz", not "16.0 oz".
  const tenths = Math.round(oz * 10);
  const lb = Math.floor(tenths / 160);
  const rest = (tenths - lb * 160) / 10;
  return lb > 0 ? `${lb} lb ${rest.toFixed(1)} oz` : `${rest.toFixed(1)} oz`;
}
