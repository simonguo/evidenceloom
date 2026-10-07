import type { EvidenceBundle } from "@/features/evidence/types";

export type SavedReportCitations = {
  scopeId: string;
  targets: ReadonlyMap<string, string>;
};

export function savedEvidenceScope(taskId: string, versionId: string): string {
  return `saved-report-evidence:${encodeURIComponent(JSON.stringify([taskId, versionId]))}`;
}

export function savedEvidenceHref(targetId: string): string {
  return `#${encodeURIComponent(targetId)}`;
}

export function savedReportCitations(taskId: string, versionId: string, verifiedBundle: EvidenceBundle): SavedReportCitations {
  const scopeId = savedEvidenceScope(taskId, versionId);
  return {
    scopeId,
    targets: new Map(verifiedBundle.records.map(({ id }) => [id, `${scopeId}:${id}`] as const)),
  };
}

type MarkdownNode = {
  type: string;
  value?: string;
  children?: MarkdownNode[];
  url?: string;
  data?: Record<string, unknown>;
};
const excluded = new Set(["link", "linkReference", "image", "imageReference", "code", "inlineCode", "html"]);

// Operate on parsed prose, never on the saved text or the export document.
export function remarkSavedReportCitations(citations: SavedReportCitations) {
  return (tree: MarkdownNode) => {
    function visit(node: MarkdownNode) {
      if (!node.children || excluded.has(node.type)) return;
      node.children = node.children.flatMap((child) => {
        if (child.type !== "text" || typeof child.value !== "string") {
          visit(child);
          return [child];
        }
        const value = child.value;
        const pieces: MarkdownNode[] = [];
        let consumed = 0;
        for (const match of value.matchAll(/\[E:(ev-[a-f0-9]{32})\]/g)) {
          const target = citations.targets.get(match[1]);
          if (!target) continue;
          const start = match.index!;
          if (start > consumed) pieces.push({ type: "text", value: value.slice(consumed, start) });
          pieces.push({ type: "link", url: savedEvidenceHref(target), children: [{ type: "text", value: match[0] }],
            data: { hProperties: { "data-saved-evidence-id": match[1] } } });
          consumed = start + match[0].length;
        }
        if (!pieces.length) return [child];
        if (consumed < value.length) pieces.push({ type: "text", value: value.slice(consumed) });
        return pieces;
      });
    }
    visit(tree);
  };
}

export function navigateSavedEvidence(citations: SavedReportCitations, recordId: string, document: Document): boolean {
  const targetId = citations.targets.get(recordId);
  if (!targetId) return false;
  const scope = document.getElementById(citations.scopeId);
  const target = document.getElementById(targetId);
  if (!scope || scope.dataset.evidenceScope !== citations.scopeId || !target || !scope.contains(target)
    || target.tagName !== "DETAILS" || target.dataset.evidenceRecordId !== recordId || !target.isConnected) return false;
  for (let ancestor: HTMLElement | null = target; ancestor; ancestor = ancestor.parentElement) {
    if (ancestor.tagName === "DETAILS") (ancestor as HTMLDetailsElement).open = true;
  }
  target.focus();
  target.scrollIntoView?.({ block: "nearest" });
  return true;
}
