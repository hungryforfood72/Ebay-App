"use client";

import { BrowserMultiFormatReader, IScannerControls } from "@zxing/browser";
import { useEffect, useRef, useState } from "react";

type Props = {
  onDetected: (upc: string) => void;
  onClose: () => void;
};

export default function BarcodeScanner({ onDetected, onClose }: Props) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const reader = new BrowserMultiFormatReader();
    let controls: IScannerControls | undefined;
    let cancelled = false;

    reader
      .decodeFromVideoDevice(
        undefined,
        videoRef.current ?? undefined,
        (result, err, ctrl) => {
          controls = ctrl;
          if (cancelled) return;
          if (result) {
            controls?.stop();
            onDetected(result.getText());
          }
        }
      )
      .catch(() => {
        if (!cancelled) setError("Couldn't access the camera.");
      });

    return () => {
      cancelled = true;
      controls?.stop();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <div className="fixed inset-0 z-50 flex flex-col bg-black">
      <div className="flex items-center justify-between p-4 text-white">
        <span className="text-sm">Point the camera at the barcode</span>
        <button
          type="button"
          onClick={onClose}
          className="rounded bg-white/10 px-3 py-1 text-sm"
        >
          Cancel
        </button>
      </div>
      <div className="relative flex-1 overflow-hidden">
        <video ref={videoRef} className="h-full w-full object-cover" muted />
        <div className="pointer-events-none absolute inset-x-8 top-1/2 h-24 -translate-y-1/2 rounded-lg border-2 border-white/80" />
      </div>
      {error && (
        <p className="bg-red-600 p-3 text-center text-sm text-white">
          {error}
        </p>
      )}
    </div>
  );
}
