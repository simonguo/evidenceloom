export function KeyValue({ label, value }: { label: string; value: string }) {
  return <div className="rounded-lg border border-zinc-900 bg-zinc-950/40 p-3"><div className="text-xs text-zinc-600">{label}</div><div className="mt-1 break-all text-sm text-zinc-200">{value || "--"}</div></div>;
}
