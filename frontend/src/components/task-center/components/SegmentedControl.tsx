import clsx from "clsx";

export function SegmentedControl({ items, value, onChange }: { items: Array<{ key: string; label: string }>; value: string; onChange: (value: string) => void }) {
  return (
    <div>
      <div className="overflow-x-auto">
        <div className="inline-flex min-w-max rounded-lg border border-zinc-800 bg-zinc-950 p-1">
          {items.map((item) => {
            const active = item.key === value;
            return (
              <button
                key={item.key}
                type="button"
                onClick={() => onChange(item.key)}
                className={clsx(
                  "whitespace-nowrap rounded-md px-3.5 py-2 text-sm font-medium transition",
                  active ? "bg-zinc-100 text-zinc-950 shadow-sm" : "text-zinc-500 hover:bg-zinc-900 hover:text-zinc-200",
                )}
              >
                {item.label}
              </button>
            );
          })}
        </div>
      </div>
    </div>
  );
}
