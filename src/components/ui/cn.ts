// Joins class names, dropping falsy entries. Deliberately not tailwind-merge:
// callers shouldn't pass classes that conflict with a component's own
// defaults (e.g. a second padding) — components expose a prop for that
// instead (see Card's `padded`).
export function cn(...classes: Array<string | false | null | undefined>): string {
  return classes.filter(Boolean).join(" ");
}
