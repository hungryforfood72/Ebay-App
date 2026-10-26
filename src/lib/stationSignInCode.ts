// The parts of scan-to-sign-in that the handheld's pages need too (no
// server imports here). The server side is src/lib/stationSignIn.ts.

// What a station PC's sign-in screen shows as a QR code (and a barcode
// under it): "SIGNIN-" + 6 letters/digits. Any scan field on the handheld
// recognizes it (ScanField) and opens the PIN prompt instead of treating it
// as a UPC or label.
export const SIGN_IN_CODE_PREFIX = "SIGNIN-";
// No 0/O, 1/I/L: the code is also shown as text, in case someone has to
// type it in.
export const SIGN_IN_CODE_ALPHABET = "23456789ABCDEFGHJKMNPQRSTUVWXYZ";
export const SIGN_IN_CODE_LENGTH = 6;

const CODE_PATTERN = new RegExp(`^${SIGN_IN_CODE_PREFIX}[${SIGN_IN_CODE_ALPHABET}]{${SIGN_IN_CODE_LENGTH}}$`);

// Trimmed and upper-cased: the scanner may add a space or send lower case.
export function normalizeSignInCode(raw: string): string {
  return raw.trim().toUpperCase();
}

export function isStationSignInCode(raw: string): boolean {
  return CODE_PATTERN.test(normalizeSignInCode(raw));
}

// 4 to 6 digits. A PIN only works together with the person's own handheld,
// already signed in with their password, so it doesn't need to be long.
export const PIN_PATTERN = /^\d{4,6}$/;

// The localStorage keys pages use to remember which station this handheld
// prints at (StationPicker, Shipping, Bins). Signing in at a station sets
// all of them to it: "I'm working at this station now".
export const HANDHELD_STATION_KEYS = ["ebay-tool.stationId", "ebay-tool.shippingStationId", "bins.printStationId"];
