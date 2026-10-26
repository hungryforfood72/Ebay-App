"use client";

import { Check, Delete } from "lucide-react";
import { useEffect, useRef } from "react";
import { cn } from "./ui/cn";

// An on-screen number pad for station PINs (Cristian, 2026-10-26: instead
// of the scanner's own keyboard popping up over the screen). Big keys for
// gloved thumbs; dots show how many digits are in, never the digits. A
// hardware keyboard's digits, Backspace and Enter work too.
export function PinPad({
  value,
  onChange,
  onSubmit,
  submitLabel = "OK",
  busy = false,
  minLength = 4,
  maxLength = 6,
}: {
  value: string;
  onChange: (value: string) => void;
  onSubmit: () => void;
  submitLabel?: string;
  busy?: boolean;
  minLength?: number;
  maxLength?: number;
}) {
  const ready = value.length >= minLength && !busy;

  // Latest values for the keyboard listener.
  const latest = useRef({ value, onChange, onSubmit, ready, busy, maxLength });
  useEffect(() => {
    latest.current = { value, onChange, onSubmit, ready, busy, maxLength };
  });

  useEffect(() => {
    // Nothing else should hold the focus (the page's scan box would bring
    // up the keyboard or swallow the keys).
    (document.activeElement as HTMLElement | null)?.blur?.();
    const onKey = (e: KeyboardEvent) => {
      const s = latest.current;
      if (s.busy) return;
      if (/^\d$/.test(e.key)) {
        e.preventDefault();
        if (s.value.length < s.maxLength) s.onChange(s.value + e.key);
      } else if (e.key === "Backspace") {
        e.preventDefault();
        s.onChange(s.value.slice(0, -1));
      } else if (e.key === "Enter" && s.ready) {
        e.preventDefault();
        s.onSubmit();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  function press(digit: string) {
    if (busy || value.length >= maxLength) return;
    onChange(value + digit);
  }

  const slots = Math.max(minLength, Math.min(maxLength, value.length + (value.length < maxLength ? 1 : 0)));
  // Shape only; colors per key (cn() doesn't merge conflicting classes).
  const shape = "grid h-14 place-items-center rounded-xl border shadow-sm select-none disabled:opacity-40";
  const key = cn(shape, "border-border bg-surface text-2xl font-semibold text-foreground active:bg-muted");

  return (
    <div className="flex flex-col gap-3">
      <div className="flex h-8 items-center justify-center gap-3" aria-label={`${value.length} digits entered`} role="status">
        {Array.from({ length: slots }, (_, i) => (
          <span
            key={i}
            className={cn("size-4 rounded-full border-2", i < value.length ? "border-primary bg-primary" : "border-zinc-300")}
            aria-hidden
          />
        ))}
      </div>
      <div className="grid grid-cols-3 gap-2">
        {["1", "2", "3", "4", "5", "6", "7", "8", "9"].map((d) => (
          <button key={d} type="button" className={key} onClick={() => press(d)} disabled={busy}>
            {d}
          </button>
        ))}
        <button
          type="button"
          className={key}
          onClick={() => onChange(value.slice(0, -1))}
          disabled={busy || !value}
          aria-label="Delete last digit"
        >
          <Delete className="size-6" aria-hidden />
        </button>
        <button type="button" className={key} onClick={() => press("0")} disabled={busy}>
          0
        </button>
        <button
          type="button"
          className={cn(shape, "border-primary bg-primary text-base font-semibold text-primary-foreground active:bg-blue-700")}
          onClick={onSubmit}
          disabled={!ready}
        >
          {busy ? "…" : (
            <span className="flex items-center gap-1">
              <Check className="size-5" aria-hidden />
              {submitLabel}
            </span>
          )}
        </button>
      </div>
    </div>
  );
}
