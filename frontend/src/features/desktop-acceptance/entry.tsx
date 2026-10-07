"use client";

import { useEffect, useRef } from "react";
import { useTaskCenter } from "@/components/task-center/context";
import { attachRealmDriver } from "./lib/driver";
import type { DriverView } from "./types";

/** Same typed neutral entry as shipping; private behavior is chosen at compilation. */
export function DesktopVerificationEntry(): null {
  const { hydrated, storageState, settings, tasks, nativeAnalysis } = useTaskCenter();
  const view = useRef<DriverView>({ hydrated, storageState, settings, tasks, nativeAnalysis });
  view.current = { hydrated, storageState, settings, tasks, nativeAnalysis };
  useEffect(() => attachRealmDriver(() => view.current), []);
  return null;
}
