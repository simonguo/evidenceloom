"use client";

import ReactMarkdown from "react-markdown";
import type { ComponentProps } from "react";
import remarkGfm from "remark-gfm";

export function ReportMarkdown({ content, remarkPlugins = [], components }: {
  content: string;
  remarkPlugins?: ComponentProps<typeof ReactMarkdown>["remarkPlugins"];
  components?: ComponentProps<typeof ReactMarkdown>["components"];
}) {
  return (
    <ReactMarkdown
      remarkPlugins={[remarkGfm, ...(remarkPlugins ?? [])]}
      components={components}
      className="report-markdown prose prose-invert prose-sm max-w-none prose-headings:text-white prose-a:text-zinc-300 prose-strong:text-slate-100"
    >
      {content}
    </ReactMarkdown>
  );
}
