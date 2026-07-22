"use client";

import { useEffect, useId, useRef, useState, type ReactNode } from "react";
import { Info } from "lucide-react";

export function MetricCard({ icon, label, value, description }: { icon: ReactNode; label: string; value: string; description: string }) {
  const [open, setOpen] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);
  const popoverId = useId();

  useEffect(() => {
    if (!open) return;
    const closeOnOutsideClick = (event: MouseEvent) => {
      if (!containerRef.current?.contains(event.target as Node)) setOpen(false);
    };
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") setOpen(false);
    };
    document.addEventListener("mousedown", closeOnOutsideClick);
    document.addEventListener("keydown", closeOnEscape);
    return () => {
      document.removeEventListener("mousedown", closeOnOutsideClick);
      document.removeEventListener("keydown", closeOnEscape);
    };
  }, [open]);

  return (
    <div ref={containerRef} className="relative rounded-lg border border-zinc-900 bg-zinc-950/50 p-4">
      <div className="flex items-center justify-between gap-3">
        <div className="flex min-w-0 items-center gap-2 text-zinc-200">
          {icon}
          <span className="truncate text-xs text-zinc-500">{label}</span>
        </div>
        <button type="button" onClick={() => setOpen((current) => !current)} aria-expanded={open} aria-controls={popoverId} title={label} className="inline-flex size-7 shrink-0 items-center justify-center rounded-md text-zinc-600 transition hover:bg-zinc-900 hover:text-zinc-200">
          <Info className="size-3.5" />
        </button>
      </div>
      <div className="mt-2 text-lg font-semibold text-white">{value}</div>

      {open && (
        <div id={popoverId} role="dialog" className="absolute right-3 top-11 z-40 w-72 max-w-[calc(100vw-3rem)] rounded-lg border border-zinc-700 bg-zinc-950 p-4 shadow-2xl">
          <div className="text-sm font-medium text-white">{label}</div>
          <p className="mt-2 text-xs leading-5 text-zinc-400">{description}</p>
        </div>
      )}
    </div>
  );
}
