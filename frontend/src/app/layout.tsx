import type { Metadata } from "next";
import type { ReactNode } from "react";
import { AppShell } from "@/components/task-center/AppShell";
import { TaskCenterProvider } from "@/components/task-center/context";
import "./globals.css";

export const metadata: Metadata = {
  title: "Evidence Loom",
  description: "Local-first multi-agent market research.",
};

export default function RootLayout({ children }: Readonly<{ children: ReactNode }>) {
  return (
    <html lang="zh-CN">
      <body>
        <TaskCenterProvider>
          <AppShell>{children}</AppShell>
        </TaskCenterProvider>
      </body>
    </html>
  );
}
