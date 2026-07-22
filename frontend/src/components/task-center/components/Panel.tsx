import type { ReactNode } from "react";
import clsx from "clsx";

export function Panel({ title, children, sticky = false, hideHeader = false }: { title: string; children: ReactNode; sticky?: boolean; hideHeader?: boolean }) {
  return (
    <div className="rounded-xl border border-zinc-900 bg-black p-5">
      {!hideHeader && (
        <div className={clsx("mb-4 bg-black", sticky && "sticky top-16 z-20 -mx-5 border-b border-zinc-900 px-5 py-4")}>
          <h3 className="text-lg font-semibold text-white">{title}</h3>
        </div>
      )}
      {children}
    </div>
  );
}
