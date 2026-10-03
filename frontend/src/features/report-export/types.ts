import type { ReportVersion, SystemLanguage } from "@/lib/types";
import type { OutputQualityView } from "@/features/output-quality/types";

export type ExportFormat = "html" | "md";

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
};
