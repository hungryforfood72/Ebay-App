export function Stat({
  label,
  value,
  highlight,
  format,
}: {
  label: string;
  value: number;
  highlight?: boolean;
  format?: "currency";
}) {
  return (
    <div className="rounded-lg border p-3">
      <p className="text-xs text-gray-500">{label}</p>
      <p className={`text-2xl font-semibold ${highlight ? "text-red-600" : ""}`}>
        {format === "currency" ? `$${value.toFixed(2)}` : value}
      </p>
    </div>
  );
}
