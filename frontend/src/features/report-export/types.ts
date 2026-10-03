import type { ReportVersion, SystemLanguage } from "@/lib/types";
import type { OutputQualityView } from "@/features/output-quality/types";
import type { EvidenceBundle, EvidenceValidation } from "@/features/evidence/types";

export type ExportFormat = "html" | "md" | "json";

export type ReportDocumentSection = {
  id: string;
  title: string;
  content: string;
};

export type ReportDocument = {
  title: string;
  disclaimer: string;
  fictionalNotice: string;
  metadata: Array<[string, string]>;
  outputQuality: OutputQualityView;
  sections: ReportDocumentSection[];
  language: SystemLanguage;
  version: ReportVersion;
  evidence: { bundle?: EvidenceBundle; invalid?: EvidenceValidation };
};
