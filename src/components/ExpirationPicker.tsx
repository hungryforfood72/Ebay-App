"use client";

import { cn } from "@/components/ui/cn";
import { X } from "lucide-react";
import { useState } from "react";

// Expiration date picker for the handheld (Cristian, 2026-10-25): year
// first, then month, then day, all big tap buttons. Months show their
// number ("10" with "Oct" under it) since that's what packages print. The
// phone's calendar started on today and made you page month by month.
//
// Picking the month already fills in that month's last day, which is what
// a package with only a month and year means; tapping a day changes it.
// value/onChange are "YYYY-MM-DD" (or "" for none), same as <input
// type="date">.

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const YEARS_BACK = 1;
const YEARS_AHEAD = 8;

type Part = "year" | "month" | "day";

function parse(value: string): { y: number; m: number; d: number } | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  return match ? { y: Number(match[1]), m: Number(match[2]), d: Number(match[3]) } : null;
}

function daysIn(y: number, m: number): number {
  return new Date(Date.UTC(y, m, 0)).getUTCDate();
}

function format(y: number, m: number, d: number): string {
  return `${y}-${String(m).padStart(2, "0")}-${String(Math.min(d, daysIn(y, m))).padStart(2, "0")}`;
}

export function ExpirationPicker({ value, onChange, label }: { value: string; onChange: (value: string) => void; label?: string }) {
  const date = parse(value);
  // Year picked but no month yet: nothing is sent up until there is one.
  const [pendingYear, setPendingYear] = useState<number | null>(null);
  const [open, setOpen] = useState<Part | null>(date ? null : "year");
  const year = date?.y ?? pendingYear;
  const thisYear = new Date().getFullYear();
  const years = Array.from({ length: YEARS_BACK + YEARS_AHEAD + 1 }, (_, i) => thisYear - YEARS_BACK + i);
  if (year != null && !years.includes(year)) years.push(year);

  function pickYear(y: number) {
    if (date) {
      onChange(format(y, date.m, date.d));
      setOpen(null);
    } else {
      setPendingYear(y);
      setOpen("month");
    }
  }

  function pickMonth(m: number) {
    if (year == null) return;
    // Keeps a day already picked; otherwise the month's last day.
    onChange(format(year, m, date?.d ?? daysIn(year, m)));
    setOpen("day");
  }

  function pickDay(d: number) {
    if (!date) return;
    onChange(format(date.y, date.m, d));
    setOpen(null);
  }

  function clear() {
    onChange("");
    setPendingYear(null);
    setOpen("year");
  }

  const chip = (part: Part, title: string, text: string | null, disabled: boolean) => (
    <button
      type="button"
      disabled={disabled}
      onClick={() => setOpen(open === part ? null : part)}
      className={cn(
        "flex min-w-0 flex-1 flex-col items-center rounded-lg border px-2 py-1.5 disabled:opacity-40",
        open === part ? "border-primary bg-blue-50" : "border-border bg-background"
      )}
    >
      <span className="text-xs text-muted-foreground">{title}</span>
      <span className="text-lg font-semibold tabular-nums text-foreground">{text ?? "--"}</span>
    </button>
  );

  const cell = (selected: boolean) =>
    cn(
      "rounded-lg border py-2.5 text-center font-semibold tabular-nums active:bg-muted",
      selected ? "border-primary bg-primary text-primary-foreground" : "border-border bg-background text-foreground"
    );

  return (
    <div className="flex flex-col gap-2" role="group" aria-label={label ?? "Expiration date"}>
      <div className="flex items-stretch gap-2">
        {chip("year", "1. Year", year != null ? String(year) : null, false)}
        {chip("month", "2. Month", date ? `${date.m} ${MONTHS[date.m - 1]}` : null, year == null)}
        {chip("day", "3. Day", date ? String(date.d) : null, !date)}
        {(date || pendingYear != null) && (
          <button
            type="button"
            onClick={clear}
            aria-label="Clear the date"
            className="grid w-10 shrink-0 place-items-center rounded-lg border border-border text-muted-foreground"
          >
            <X className="size-4" aria-hidden />
          </button>
        )}
      </div>

      {open === "year" && (
        <div className="grid grid-cols-5 gap-1.5">
          {years.map((y) => (
            <button key={y} type="button" className={cell(y === year)} onClick={() => pickYear(y)}>
              {y}
            </button>
          ))}
        </div>
      )}

      {open === "month" && year != null && (
        <div className="grid grid-cols-4 gap-1.5">
          {MONTHS.map((name, i) => (
            <button key={name} type="button" className={cn(cell(date?.m === i + 1), "py-1.5")} onClick={() => pickMonth(i + 1)}>
              <span className="block text-xl leading-tight">{i + 1}</span>
              <span className="block text-xs font-medium opacity-80">{name}</span>
            </button>
          ))}
        </div>
      )}

      {open === "day" && date && (
        <>
          <p className="text-xs text-muted-foreground">
            Only a month and year on the package? Leave it on {daysIn(date.y, date.m)}, the last day, and tap Next.
          </p>
          <div className="grid grid-cols-7 gap-1">
            {Array.from({ length: daysIn(date.y, date.m) }, (_, i) => i + 1).map((d) => (
              <button key={d} type="button" className={cn(cell(d === date.d), "py-2 text-sm")} onClick={() => pickDay(d)}>
                {d}
              </button>
            ))}
          </div>
        </>
      )}
    </div>
  );
}
