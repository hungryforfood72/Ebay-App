"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { DYMO_VENDOR_ID, HID_POS_SCALE_USAGE_PAGE, SCALE_HID_FILTERS, parseScaleReport, type ScaleReading } from "@/lib/warehouse/scale";

// The station's USB scale through WebHID (Chrome/Edge on a desktop only).
//
// - First time on a PC: someone clicks "Connect scale" and picks it in
//   Chrome's device list (requestDevice only works from a click).
// - After that, Chrome remembers the permission, so on page load we just
//   reopen it from getDevices().
// - The DYMO M25 turns itself off after 3 idle minutes, and nothing we send
//   over USB stops that (tested, see scale.ts). On USB power it stays
//   connected and reports unit 0, which we show as "Scale is off"; it flips
//   back to connected on the next real reading. If it does drop off USB
//   (on batteries), we reopen it on the HID "connect" event the moment
//   someone presses its power button. No click needed either way.
//
// TypeScript's DOM types don't include WebHID yet, so the bits we use are
// declared here.

type HidCollection = { usagePage?: number; usage?: number };
type HidDevice = EventTarget & {
  opened: boolean;
  vendorId: number;
  productId: number;
  productName: string;
  collections: HidCollection[];
  open(): Promise<void>;
  close(): Promise<void>;
};
type HidInputReportEvent = Event & { device: HidDevice; reportId: number; data: DataView };
type HidConnectionEvent = Event & { device: HidDevice };
type Hid = EventTarget & {
  getDevices(): Promise<HidDevice[]>;
  requestDevice(options: { filters: typeof SCALE_HID_FILTERS }): Promise<HidDevice[]>;
};

function getHid(): Hid | null {
  if (typeof navigator === "undefined") return null;
  return ((navigator as unknown as { hid?: Hid }).hid ?? null) as Hid | null;
}

function isScale(d: HidDevice): boolean {
  return d.vendorId === DYMO_VENDOR_ID || d.collections.some((c) => c.usagePage === HID_POS_SCALE_USAGE_PAGE);
}

// Remembered per PC so a reload with the scale switched off says "Scale is
// off" instead of asking to connect a scale that's already set up (Chrome
// only lists devices that are plugged in and on).
const CONNECTED_BEFORE_KEY = "station-scale-connected-before";

function readFlag(): boolean {
  try {
    return localStorage.getItem(CONNECTED_BEFORE_KEY) === "1";
  } catch {
    return false;
  }
}

function writeFlag() {
  try {
    localStorage.setItem(CONNECTED_BEFORE_KEY, "1");
  } catch {
    // Private window or storage blocked: we'll just ask to connect again.
  }
}

export type ScaleConnection =
  | "checking" // page just loaded
  | "unsupported" // no WebHID in this browser
  | "not-set-up" // never connected on this PC: show the Connect button
  | "off" // the DYMO powered itself off (reports unit 0, or dropped off USB)
  | "connected"
  | "error"; // found it but couldn't open it

export type ScaleState = {
  connection: ScaleConnection;
  deviceName: string | null;
  reading: ScaleReading | null;
  // When the last report arrived (ms), for "last reading 40s ago".
  lastReportAt: number | null;
  error: string | null;
  connect: () => Promise<void>;
};

export function useScale(): ScaleState {
  const [connection, setConnection] = useState<ScaleConnection>("checking");
  const [deviceName, setDeviceName] = useState<string | null>(null);
  const [reading, setReading] = useState<ScaleReading | null>(null);
  const [lastReportAt, setLastReportAt] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  const deviceRef = useRef<HidDevice | null>(null);
  const lastKeyRef = useRef("");
  const lastStampRef = useRef(0);

  const onReport = useCallback((e: Event) => {
    const ev = e as HidInputReportEvent;
    const r = parseScaleReport(ev.data, ev.reportId);
    if (!r) return;
    const now = Date.now();
    // Off but still on USB: the same screen as being unplugged.
    setConnection(r.status === "off" ? "off" : "connected");
    // The scale streams several reports a second; only re-render when the
    // reading changes (or once a second, to keep "last reading" fresh).
    const key = `${r.status}|${r.weightOz}`;
    if (key !== lastKeyRef.current) {
      lastKeyRef.current = key;
      setReading(r);
    }
    if (now - lastStampRef.current >= 1000) {
      lastStampRef.current = now;
      setLastReportAt(now);
    }
  }, []);

  const attach = useCallback(
    async (device: HidDevice) => {
      if (deviceRef.current === device && device.opened) return;
      setError(null);
      try {
        if (!device.opened) await device.open();
      } catch {
        setConnection("error");
        setError(
          "Found the scale but couldn't open it. If this station page is open in another tab or window, close that one, then press Connect scale."
        );
        return;
      }
      deviceRef.current?.removeEventListener("inputreport", onReport);
      deviceRef.current = device;
      device.addEventListener("inputreport", onReport);
      lastKeyRef.current = "";
      setDeviceName(device.productName || "USB scale");
      setConnection("connected");
      writeFlag();
    },
    [onReport]
  );

  useEffect(() => {
    const hid = getHid();
    if (!hid) {
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setConnection("unsupported");
      return;
    }
    let cancelled = false;

    hid
      .getDevices()
      .then((devices) => {
        if (cancelled) return;
        const scale = devices.find(isScale);
        if (scale) return attach(scale);
        setConnection(readFlag() ? "off" : "not-set-up");
      })
      .catch(() => !cancelled && setConnection("not-set-up"));

    // Power button pressed (or plugged back in): reopen without a click.
    const onConnect = (e: Event) => {
      const { device } = e as HidConnectionEvent;
      if (isScale(device) && !deviceRef.current?.opened) void attach(device);
    };
    const onDisconnect = (e: Event) => {
      const { device } = e as HidConnectionEvent;
      if (device !== deviceRef.current) return;
      device.removeEventListener("inputreport", onReport);
      deviceRef.current = null;
      lastKeyRef.current = "";
      setReading(null);
      setConnection("off");
    };
    hid.addEventListener("connect", onConnect);
    hid.addEventListener("disconnect", onDisconnect);

    return () => {
      cancelled = true;
      hid.removeEventListener("connect", onConnect);
      hid.removeEventListener("disconnect", onDisconnect);
      const device = deviceRef.current;
      if (device) {
        device.removeEventListener("inputreport", onReport);
        void device.close().catch(() => {});
        deviceRef.current = null;
      }
    };
  }, [attach, onReport]);

  // From a button click only (Chrome requires a user gesture).
  const connect = useCallback(async () => {
    const hid = getHid();
    if (!hid) return;
    setError(null);
    try {
      const picked = await hid.requestDevice({ filters: SCALE_HID_FILTERS });
      const scale = picked.find(isScale) ?? picked[0];
      if (!scale) return; // closed the chooser without picking
      await attach(scale);
    } catch {
      setError("Couldn't connect to the scale. Make sure it's plugged in and on, then try again.");
    }
  }, [attach]);

  return { connection, deviceName, reading, lastReportAt, error, connect };
}
