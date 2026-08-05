// "A1, A2, ..., A10" instead of the lexicographic "A1, A10, A2, ..." you get
// from a plain string sort — matters for shelf locations like A1-A50.
const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: "base" });

export function naturalSort<T>(items: T[], getLabel: (item: T) => string): T[] {
  return [...items].sort((a, b) => collator.compare(getLabel(a), getLabel(b)));
}
