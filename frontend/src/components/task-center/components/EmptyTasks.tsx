import Link from "next/link";
import { Plus } from "lucide-react";
import { createTranslator } from "@/lib/i18n";
import { useTaskCenter } from "../context";

export function EmptyTasks() {
  const { settings } = useTaskCenter();
  const t = createTranslator(settings.systemLanguage);
  return (
    <Link href="/tasks/new" className="block rounded-xl border border-dashed border-zinc-800 bg-black/30 p-8 text-center transition hover:border-zinc-600">
      <Plus className="mx-auto size-8 text-zinc-200" />
      <div className="mt-3 text-base font-semibold text-white">{t("createFirstTask")}</div>
      <div className="mt-1 text-sm text-zinc-500">{t("createFirstTaskHint")}</div>
    </Link>
  );
}
