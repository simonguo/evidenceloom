import clsx from "clsx";
import { createTranslator } from "@/lib/i18n";
import { useTaskCenter } from "../context";

export function CheckCard({ label, ok }: { label: string; ok?: boolean }) {
  const { settings } = useTaskCenter();
  const t = createTranslator(settings.systemLanguage);
  return <div className="rounded-lg border border-zinc-900 bg-zinc-950/50 p-4"><div className="text-xs text-zinc-600">{label}</div><div className={clsx("mt-2 text-sm font-semibold", ok === undefined ? "text-zinc-500" : ok ? "text-emerald-300" : "text-rose-300")}>{ok === undefined ? t("notChecked") : ok ? t("passed") : t("failed")}</div></div>;
}
