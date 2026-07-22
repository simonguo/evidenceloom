import clsx from "clsx";

export function SummaryTile({ label, value, highlight = false }: { label: string; value: string; highlight?: boolean }) {
  return <div className={clsx("rounded-lg border bg-black/35 p-4", highlight ? "border-zinc-600" : "border-zinc-800")}><div className="text-xs text-zinc-600">{label}</div><div className="mt-2 truncate text-sm font-semibold text-white">{value}</div></div>;
}
