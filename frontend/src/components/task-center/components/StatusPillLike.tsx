import clsx from "clsx";
import { createTranslator } from "@/lib/i18n";
import { useTaskCenter } from "../context";

export function StatusPillLike({ ok }: { ok?: boolean }) {
  const { settings } = useTaskCenter();
  const t = createTranslator(settings.systemLanguage);
  if (ok === undefined) return null;
  return <span className={clsx("rounded-full border px-3 py-1.5 text-xs", ok ? "border-emerald-300/50 bg-emerald-400/10 text-emerald-100" : "border-rose-300/50 bg-rose-400/10 text-rose-100")}>{ok ? t("healthy") : t("needsAttention")}</span>;
}
