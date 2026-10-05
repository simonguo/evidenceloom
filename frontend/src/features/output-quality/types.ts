export type OutputQualityAgent = "research_manager" | "trader" | "portfolio_manager" | "sentiment";
export type OutputQualityReason = "structured_unavailable" | "no_tool_call" | "schema_validation_failed" | "unsupported_format";

export type OutputQualityRecord = {
  status: "validated_schema";
  schema: string;
  source: "structured";
  reason?: never;
} | {
  status: "unvalidated_text";
  schema: string;
  source: "raw_response" | "plain_generation";
  reason: OutputQualityReason;
};

export type OutputQuality = Partial<Record<OutputQualityAgent, OutputQualityRecord>>;

export type OutputQualityView = {
  title: string;
  disclaimer: string;
  emptyMessage: string;
  hasUnvalidatedText: boolean;
  entries: Array<{
    agent: string;
    schema: string;
    status: string;
    source: string;
    reason: string;
    validated: boolean;
  }>;
};
