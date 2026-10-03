import { renderToStaticMarkup } from "react-dom/server";
import { createElement } from "react";
import ReactMarkdown, { defaultUrlTransform } from "react-markdown";
import remarkGfm from "remark-gfm";
import type { Components } from "react-markdown";
import type { ReportDocument } from "../types";
import { evidenceAbsent, evidenceNotice, linkEvidenceCitations } from "@/features/evidence/lib/export";
import { renderMemoryHtml } from "@/features/memory/lib/render-appendix";

const markdownComponents: Components = {
  a: ({ href, children }) => {
    const url = safeUrl(href);
    return createElement(
      "a",
      url.startsWith("#") ? { href: url } : { href: url, target: "_blank", rel: "noreferrer noopener" },
      children,
    );
  },
  img: ({ alt }) => createElement("span", { className: "omitted-image" }, `[${alt || "image"} omitted]`),
};

export function renderReportHtml(document: ReportDocument) {
  const invalid = document.evidence.invalid ?? document.version.evidenceValidation;
  if (invalid) document = { ...document, evidence: { invalid } };
  const metadataRows = document.metadata
    .map(([label, value]) => `<tr><th>${escapeHtml(label)}</th><td>${escapeHtml(value)}</td></tr>`)
    .join("");
  const toc = document.sections
    .map((section, index) => `<li><a href="#${section.id}">${index + 1}. ${escapeHtml(section.title)}</a></li>`)
    .join("");
  const sections = document.sections
    .map((section, index) => {
      const content = renderToStaticMarkup(
        createElement(ReactMarkdown, {
          remarkPlugins: [remarkGfm],
          skipHtml: true,
          urlTransform: safeUrl,
          components: markdownComponents,
          children: linkEvidenceCitations(section.content, document.evidence.bundle),
        }),
      );
      return `<section id="${section.id}"><h2>${index + 1}. ${escapeHtml(section.title)}</h2>${content}</section>`;
    })
    .join("");
  const fictionalNotice = document.fictionalNotice
    ? `<div class="fictional">${escapeHtml(document.fictionalNotice)}</div>`
    : "";
  const quality = document.outputQuality;
  const qualityEntries = quality.entries.length
    ? `<ul>${quality.entries.map((entry) => `<li><strong>${escapeHtml(entry.agent)}: ${escapeHtml(entry.status)}</strong><p>${escapeHtml(entry.schema)} · ${escapeHtml(entry.source)}</p>${entry.reason ? `<p>${escapeHtml(entry.reason)}</p>` : ""}</li>`).join("")}</ul>`
    : `<p>${escapeHtml(quality.emptyMessage)}</p>`;

  return `<!doctype html>
<html lang="${document.language === "zh" ? "zh-CN" : "en"}">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; img-src data:; font-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'; connect-src 'none';">
  <title>${escapeHtml(document.title)}</title>
  <style>${reportStyles}</style>
</head>
<body>
  <main>
    <header>
      <div class="eyebrow">Evidence Loom · v${document.version.versionNumber}</div>
      <h1>${escapeHtml(document.title)}</h1>
      ${fictionalNotice}
      <p class="disclaimer">${escapeHtml(document.disclaimer)}</p>
    </header>
    <table class="metadata"><tbody>${metadataRows}</tbody></table>
    <section class="quality${quality.hasUnvalidatedText ? " fallback" : ""}" aria-label="${escapeHtml(quality.title)}">
      <h2>${escapeHtml(quality.title)}</h2>
      <p>${escapeHtml(quality.disclaimer)}</p>
      ${qualityEntries}
    </section>
    <nav aria-label="Table of contents"><ol>${toc}</ol></nav>
    ${sections}
    ${renderEvidenceAppendix(document)}
    ${renderMemoryHtml(document.version, document.language)}
  </main>
</body>
</html>`;
}

function renderEvidenceAppendix(document: ReportDocument) {
  const bundle = document.evidence.bundle;
  const title = document.language === "zh" ? "研究证据附录" : "Research evidence appendix";
  if (!bundle) return `<section id="evidence-appendix"><h2>${title}</h2><p>${escapeHtml(evidenceAbsent(document.language, document.evidence.invalid))}</p></section>`;
  const records = bundle.records.map((record) => `<article id="${record.id}"><h3>[E:${record.id}] · ${escapeHtml(record.tool)} · ${record.status}</h3><p>SHA-256: ${record.output_sha256}</p><pre>${escapeHtml(JSON.stringify(record, null, 2))}</pre><h4>${document.language === "zh" ? "确切的模型输入" : "Exact model input"}</h4><pre>${escapeHtml(String(bundle.artifacts[record.output_sha256].payload))}</pre>${record.sources.filter((source) => source.data_sha256).map((source) => `<h4>${document.language === "zh" ? "完整精度的标准化数据" : "Full-precision normalized data"} · ${source.data_sha256}</h4><pre>${escapeHtml(JSON.stringify(bundle.artifacts[source.data_sha256!], null, 2))}</pre>`).join("")}</article>`).join("");
  return `<section id="evidence-appendix"><h2>${title}</h2><p>${escapeHtml(evidenceNotice(document.language))}</p><p>Bundle SHA-256: ${bundle.bundle_sha256}</p><h3>${document.language === "zh" ? "引用解析审计" : "Citation resolution audit"}</h3><pre>${escapeHtml(JSON.stringify(bundle.citation_audit, null, 2))}</pre>${records}<details open><summary>${document.language === "zh" ? "完整证据包（含所有内容）" : "Complete evidence bundle (all payloads included)"}</summary><pre id="evidence-bundle-json">${escapeHtml(JSON.stringify(bundle, null, 2))}</pre></details></section>`;
}

function safeUrl(url: string | undefined) {
  if (!url) return "";
  const transformed = defaultUrlTransform(url);
  return /^(https?:|mailto:|#)/i.test(transformed) ? transformed : "";
}

function escapeHtml(value: string) {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

const reportStyles = `
:root { color-scheme: light; font-family: Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; }
* { box-sizing: border-box; }
body { margin: 0; background: #f4f4f5; color: #18181b; line-height: 1.65; }
main { width: min(920px, calc(100% - 32px)); margin: 32px auto; padding: 48px; background: #fff; border: 1px solid #e4e4e7; border-radius: 18px; box-shadow: 0 24px 80px rgba(24,24,27,.08); }
header { border-bottom: 1px solid #e4e4e7; padding-bottom: 24px; }
.eyebrow { color: #71717a; font-size: 12px; font-weight: 700; letter-spacing: .12em; text-transform: uppercase; }
h1 { margin: 8px 0 12px; font-size: clamp(28px, 5vw, 46px); line-height: 1.1; }
h2 { margin-top: 48px; padding-bottom: 10px; border-bottom: 1px solid #e4e4e7; font-size: 24px; }
h3 { margin-top: 28px; font-size: 18px; }
h4 { margin-top: 24px; }
p, li { color: #3f3f46; }
a { color: #1d4ed8; text-underline-offset: 3px; }
.disclaimer { margin: 0; color: #71717a; font-size: 13px; }
.fictional { margin: 18px 0; padding: 12px 14px; border: 1px solid #f59e0b; border-radius: 10px; background: #fffbeb; color: #92400e; font-weight: 700; }
.metadata { width: 100%; margin: 28px 0; border-collapse: collapse; font-size: 13px; }
.metadata th, .metadata td { padding: 9px 12px; border: 1px solid #e4e4e7; text-align: left; vertical-align: top; overflow-wrap: anywhere; }
.metadata th { width: 30%; background: #fafafa; color: #52525b; }
.quality { padding: 18px 22px; border: 1px solid #d4d4d8; border-radius: 12px; background: #fafafa; }
.quality h2 { margin-top: 0; font-size: 20px; }
.quality p { font-size: 13px; }
.quality.fallback { border-color: #f59e0b; background: #fffbeb; }
nav { margin: 28px 0; padding: 18px 22px; border-radius: 12px; background: #fafafa; }
nav ol { margin: 0; padding-left: 22px; }
table:not(.metadata) { width: 100%; display: block; overflow-x: auto; border-collapse: collapse; font-size: 13px; }
table:not(.metadata) th, table:not(.metadata) td { padding: 8px 10px; border: 1px solid #d4d4d8; text-align: left; }
pre { overflow-x: auto; padding: 16px; border-radius: 10px; background: #18181b; color: #f4f4f5; }
code { overflow-wrap: anywhere; }
blockquote { margin-left: 0; padding-left: 16px; border-left: 3px solid #a1a1aa; color: #52525b; }
.omitted-image { color: #71717a; font-style: italic; }
@media (max-width: 640px) { main { width: 100%; margin: 0; padding: 24px 18px; border: 0; border-radius: 0; } }
@media print { body { background: #fff; } main { width: 100%; margin: 0; padding: 0; border: 0; box-shadow: none; } nav { break-inside: avoid; } section { break-inside: auto; } }
`;
