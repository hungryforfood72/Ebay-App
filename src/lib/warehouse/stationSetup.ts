import { DYMO_M25_NEW_PRODUCT_ID, DYMO_M25_PRODUCT_ID, DYMO_VENDOR_ID } from "./scale";

// What a station PC needs besides the app: the Chrome shortcut that opens
// the station page and the Chrome policies. One source for the station
// page's manual setup steps and the print helper installer
// (printHelperInstaller.ts), which does them for you. Client-safe.

// Its own Chrome profile (--user-data-dir): --kiosk-printing covers every
// window of the Chrome it starts, so without one, a scan form printed from
// the normal Chrome would also go straight to the Rollo with no dialog.
// --autoplay-policy lets it beep when the scale turns off without anyone
// clicking the page first.
export const STATION_PROFILE_DIR = "C:\\ChromeStation";

// signInKey (from the installer): the shortcut opens through
// /api/station-pc/setup, which sets this PC up for scanner sign-in
// (src/lib/stationSignIn.ts) and then shows the station page, or its QR
// screen when no one is signed in. No password needed on a station PC.
export function stationShortcutArgs(origin: string, stationId: string, signInKey?: string): string {
  const url = signInKey
    ? `${origin}/api/station-pc/setup?d=${encodeURIComponent(`${stationId}.${signInKey}`)}`
    : `${origin}/station/${stationId}`;
  return `--user-data-dir=${STATION_PROFILE_DIR} --kiosk-printing --autoplay-policy=no-user-gesture-required --app=${url}`;
}

export const DEFAULT_CHROME_PATH = "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe";

// Chrome policies for the station PC (HKLM\SOFTWARE\Policies\Google\Chrome):
//   PrintPreviewUseSystemDefaultPrinter: without it, Chrome's silent
//     printing goes to whatever printer that Chrome profile printed to
//     LAST, not the Windows default. Once something printed on the regular
//     printer from the station's Chrome (or while the default was switched
//     for a scan form), labels kept going there even after the default was
//     set back and the shortcut remade (Cristian, 2026-10-21).
//   WebHidAllowDevicesForUrls: always lets this site use the DYMO M25
//     (both USB product ids it ships with), for when Chrome forgets the
//     scale every time it powers off.
export function stationChromePolicies(origin: string): { name: string; type: "dword" | "string"; value: string | number }[] {
  const devices = [DYMO_M25_PRODUCT_ID, DYMO_M25_NEW_PRODUCT_ID].map((pid) => ({ vendor_id: DYMO_VENDOR_ID, product_id: pid }));
  return [
    { name: "PrintPreviewUseSystemDefaultPrinter", type: "dword", value: 1 },
    { name: "WebHidAllowDevicesForUrls", type: "string", value: JSON.stringify([{ devices, urls: [origin] }]) },
  ];
}

// The same policies as a .reg file, for doing it by hand.
export function stationPolicyRegFile(origin: string): string {
  const esc = (s: string) => s.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
  return [
    "Windows Registry Editor Version 5.00",
    "",
    "[HKEY_LOCAL_MACHINE\\SOFTWARE\\Policies\\Google\\Chrome]",
    ...stationChromePolicies(origin).map((p) =>
      p.type === "dword" ? `"${p.name}"=dword:${Number(p.value).toString(16).padStart(8, "0")}` : `"${p.name}"="${esc(String(p.value))}"`
    ),
  ].join("\n");
}
