"use client";

import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";

export function ReportMarkdown({ content }: { content: string }) {
  return (
    <ReactMarkdown
      remarkPlugins={[remarkGfm]}
      className="report-markdown prose prose-invert prose-sm max-w-none prose-headings:text-white prose-a:text-zinc-300 prose-strong:text-slate-100"
    >
      {content}
    </ReactMarkdown>
  );
}
