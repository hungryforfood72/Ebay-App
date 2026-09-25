"use client";

import { Check, Keyboard, ScanBarcode } from "lucide-react";
import { useEffect, useRef, useState, type ReactNode } from "react";
import { cn } from "./ui/cn";

// A field meant to be filled by the handheld scanner, not typed into.
//
// - inputMode="none" keeps the field focused and receiving the scanner's
//   keystrokes while telling Android not to pop the on-screen keyboard up
//   over half the screen. The ⌨ button flips it to a normal typing field
//   for the barcode that won't scan.
// - A finished scan fires onScan on its own, no Search tap: either the
//   scanner's Enter suffix, or — for a scanner configured without one — a
//   short pause after the input stops.
//   - On a touch device (the Wasp handheld), any input in scan mode is the
//     scanner: the on-screen keyboard is hidden, so a person can't type
//     there at all. So ANY input followed by a pause counts, regardless of
//     length or speed — a 2-character shelf code like "A5" included.
//     (Confirmed in testing: a speed-only rule missed short shelf codes.)
//   - With a physical keyboard (a desktop), people do type into these
//     fields, so only unmistakable scanner input counts there: a burst
//     faster than anyone types, or a whole barcode committed in one event.
//   Detection is off entirely in manual typing mode: Android keyboards can
//   commit a whole autocompleted word at once, which would look like a scan.
//
// Can't be verified from a desktop browser against the real Wasp unit —
// the ⌨ fallback is there in case its scan service delivers input in some
// way this doesn't recognize.

// Gap between keystrokes below which input is assumed to come from the
// scanner rather than a person.
const SCANNER_KEY_GAP_MS = 35;
// Quiet period after a scanner burst before treating the scan as complete.
const SCAN_SETTLE_MS = 120;
// A single input event adding at least this many characters is a scanner
// committing the whole barcode at once (or a paste — same intent).
const BULK_INSERT_CHARS = 4;

export function ScanField({
  id,
  label,
  prompt,
  value,
  onChange,
  onScan,
  autoFocus = false,
  numeric = false,
  list,
  trailing,
  hint,
}: {
  id: string;
  label: string;
  // Shown while the field is waiting for a scan, e.g. "Scan the shelf location".
  prompt: string;
  value: string;
  onChange: (value: string) => void;
  onScan: () => void;
  autoFocus?: boolean;
  // Which on-screen keyboard to show in manual typing mode.
  numeric?: boolean;
  list?: string;
  trailing?: ReactNode;
  // Replaces the default idle hint line.
  hint?: ReactNode;
}) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [typing, setTyping] = useState(false);
  const [focused, setFocused] = useState(false);

  // The timer fires after the component re-renders with the final
  // character, so it has to call the *latest* onScan — the one closing over
  // the updated value — not the one captured when the timer was set.
  const onScanRef = useRef(onScan);
  useEffect(() => {
    onScanRef.current = onScan;
  });

  // Touchscreen with no physical keyboard — see the comment at the top.
  const touchDevice = useRef(false);
  useEffect(() => {
    touchDevice.current = window.matchMedia("(pointer: coarse)").matches;
  }, []);

  const lastInputAt = useRef(0);
  const fastRun = useRef(0);
  const settleTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Guards against the settle timer re-firing for a scan Enter already handled.
  const handledValue = useRef<string | null>(null);

  useEffect(() => () => clearTimeout(settleTimer.current ?? undefined), []);

  function submit() {
    clearTimeout(settleTimer.current ?? undefined);
    settleTimer.current = null;
    fastRun.current = 0;
    handledValue.current = inputRef.current?.value ?? null;
    onScanRef.current();
  }

  function handleChange(raw: string) {
    // A new scan into a field whose last scan was already submitted (e.g. a
    // lookup that came back "not found") replaces it instead of appending
    // to it — otherwise the rescan becomes a 24-digit mashup of two
    // barcodes.
    const next =
      !typing && handledValue.current !== null && handledValue.current === value && raw.startsWith(value)
        ? raw.slice(value.length)
        : raw;
    const now = Date.now();
    const added = raw.length - value.length;
    const gap = now - lastInputAt.current;
    lastInputAt.current = now;
    fastRun.current = gap < SCANNER_KEY_GAP_MS ? fastRun.current + 1 : 0;
    handledValue.current = null;
    onChange(next);

    if (typing || !next.trim()) return;
    const looksLikeScan = touchDevice.current || added >= BULK_INSERT_CHARS || fastRun.current >= 3;
    clearTimeout(settleTimer.current ?? undefined);
    if (looksLikeScan) {
      settleTimer.current = setTimeout(() => {
        if (handledValue.current !== inputRef.current?.value) submit();
      }, SCAN_SETTLE_MS);
    }
  }

  function toggleTyping() {
    const nowTyping = !typing;
    setTyping(nowTyping);
    // Android only re-reads inputmode on focus, so blur and refocus to make
    // the keyboard actually appear (or go away) right now.
    const input = inputRef.current;
    if (!input) return;
    input.blur();
    requestAnimationFrame(() => input.focus());
  }

  const waiting = !value && focused && !typing;
  const done = Boolean(value) && !focused;

  return (
    <div>
      <label htmlFor={id} className="mb-1.5 flex items-center justify-between text-sm font-medium text-foreground">
        {label}
        {done && (
          <span className="inline-flex items-center gap-1 text-xs font-medium text-success">
            <Check className="size-3.5" aria-hidden />
            Scanned
          </span>
        )}
      </label>
      <div className="flex gap-2">
        <div className="relative min-w-0 flex-1">
          <input
            ref={inputRef}
            id={id}
            type="text"
            inputMode={typing ? (numeric ? "numeric" : "text") : "none"}
            autoComplete="off"
            autoCorrect="off"
            autoCapitalize="off"
            spellCheck={false}
            enterKeyHint="go"
            list={list}
            autoFocus={autoFocus}
            value={value}
            onChange={(e) => handleChange(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                e.preventDefault();
                submit();
              }
            }}
            onFocus={() => setFocused(true)}
            onBlur={() => setFocused(false)}
            // The full prompt is in the hint line below — too long to fit
            // in the box itself at the scanner's width.
            placeholder={typing ? "Type it in" : focused ? "Waiting for scan…" : "Tap here, then scan"}
            className={cn(
              "block h-14 w-full rounded-lg border bg-surface pl-11 pr-3 text-lg text-foreground shadow-sm transition-colors",
              "placeholder:text-zinc-400 focus:outline-none",
              waiting
                ? "border-primary ring-4 ring-primary/15"
                : focused
                  ? "border-primary ring-2 ring-primary/25"
                  : done
                    ? "border-green-300 bg-green-50/40"
                    : "border-border"
            )}
          />
          <span className="pointer-events-none absolute inset-y-0 left-3 flex items-center">
            {typing ? (
              <Keyboard className="size-5 text-muted-foreground" aria-hidden />
            ) : (
              <ScanBarcode
                className={cn("size-5", waiting ? "animate-pulse text-primary" : "text-muted-foreground")}
                aria-hidden
              />
            )}
          </span>
        </div>
        <button
          type="button"
          onClick={toggleTyping}
          aria-pressed={typing}
          aria-label={typing ? "Switch back to scanning" : "Type it in instead"}
          title={typing ? "Switch back to scanning" : "Type it in instead"}
          className={cn(
            "grid size-14 shrink-0 place-items-center rounded-lg border shadow-sm transition-colors",
            typing ? "border-primary bg-blue-50 text-primary" : "border-border bg-surface text-muted-foreground hover:bg-muted"
          )}
        >
          <Keyboard className="size-5" aria-hidden />
        </button>
        {trailing}
      </div>
      <p className={cn("mt-1.5 text-xs", waiting ? "font-medium text-primary" : "text-muted-foreground")}>
        {typing
          ? "Typing mode — press Go/Enter when done."
          : waiting
            ? `${prompt}…`
            : (hint ?? "Scans submit on their own — no need to tap search.")}
      </p>
    </div>
  );
}
