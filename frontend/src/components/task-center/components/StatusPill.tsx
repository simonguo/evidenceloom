import clsx from "clsx";
import { createTranslator } from "@/lib/i18n";
import type { TaskStatus } from "@/lib/types";
import { taskStatusStyle } from "../constants";
import { useTaskCenter } from "../context";

export function StatusPill({ status }: { status: TaskStatus }) {
  const { settings } = useTaskCenter();
  const t = createTranslator(settings.systemLanguage);
  return <span className={clsx("inline-flex shrink-0 whitespace-nowrap rounded-full border px-2.5 py-1 text-xs capitalize", taskStatusStyle[status])}>{t(status)}</span>;
}
