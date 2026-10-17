"use client";

import { useEffect, useRef } from "react";

// Calls onTick every `ms`, even while the station window is minimized or
// covered by another window. Chrome slows a hidden page's own timers down
// to once a minute after a few minutes, which would make labels print a
// minute late and the station look offline. Timers inside a Web Worker
// aren't slowed down that way, so the beat comes from a tiny worker and
// the page just reacts to its messages. Falls back to setInterval if a
// worker can't be made.
export function useTicker(ms: number, onTick: () => void) {
  const tickRef = useRef(onTick);
  useEffect(() => {
    tickRef.current = onTick;
  });

  useEffect(() => {
    const tick = () => tickRef.current();
    let worker: Worker | null = null;
    let url: string | null = null;
    let interval: ReturnType<typeof setInterval> | null = null;
    try {
      url = URL.createObjectURL(
        new Blob([`setInterval(function(){postMessage(0)},${ms});`], { type: "text/javascript" })
      );
      worker = new Worker(url);
      worker.onmessage = tick;
    } catch {
      interval = setInterval(tick, ms);
    }
    return () => {
      worker?.terminate();
      if (url) URL.revokeObjectURL(url);
      if (interval) clearInterval(interval);
    };
  }, [ms]);
}
