"use client";
import { useState } from "react";
import type { AnalysisTask, ReportVersion, SystemLanguage } from "@/lib/types";
import { useIdentityCheck } from "../hooks/useIdentityCheck";
import { identityAbsent, identityAlignment, identityNotice, identityTitle } from "../lib/display";
export function IdentityInspector({
  snapshot,
  language,
}: {
  snapshot: AnalysisTask | ReportVersion;
  language: SystemLanguage;
}) {
  const { saved, status } = useIdentityCheck(snapshot),
    zh = language === "zh",
    assessment = saved?.effectiveRequestIdentity;
  const [openHash, setOpenHash] = useState<string>();
  return (
    <section
      aria-label={identityTitle(language)}
      className="rounded-lg border border-zinc-800 bg-zinc-950/50 p-4"
    >
      <h3 className="text-sm font-semibold text-zinc-200">{identityTitle(language)}</h3>
      <p className="mt-2 text-xs leading-5 text-zinc-500">{identityNotice(language)}</p>
      <p aria-live="polite" className="mt-3 text-xs text-zinc-400">
        {status === "checking"
          ? zh
            ? "正在核验保存的请求对照"
            : "Checking the saved request assessment"
          : status === "invalid"
            ? zh
              ? "请求对照附件无效；导出被阻止"
              : "Invalid request assessment; export blocked"
            : !assessment
              ? identityAbsent(language)
              : `${zh ? "记录 / 来源" : "Records / sources"}: ${assessment.summary.record_count} / ${assessment.summary.source_count} · ${zh ? "一致 / 冲突 / 未知 / 参考替代 / 全局" : "Consistent / conflict / unknown / proxy / global"}: ${assessment.summary.consistent_count} / ${assessment.summary.conflict_count} / ${assessment.summary.unknown_count} / ${assessment.summary.proxy_count} / ${assessment.summary.not_applicable_count}`}
      </p>
      {saved?.identityValidation && (
        <p role="alert" className="mt-2 text-xs text-amber-400">
          {saved.identityValidation.reason}
        </p>
      )}
      {assessment && status === "verified" && (
        <div className="mt-4 space-y-3 text-xs text-zinc-400">
          <p>
            {zh ? "请求代码 / 对照时间（UTC）" : "Requested identifier / assessment time (UTC)"}:{" "}
            <code>{assessment.instrument}</code> · {assessment.reviewed_at}
          </p>
          <p>
            {zh
              ? "提供方请求：未知 · 提供方解析实体：未知"
              : "Provider request: unknown · Provider-resolved entity: unknown"}
          </p>
          {assessment.summary.unsafe_record_ids.length > 0 && (
            <p className="break-all text-amber-400">
              {zh
                ? "此策略标记为不可用于自动推荐的请求记录"
                : "Request records flagged by this policy as unsafe for automatic recommendations"}
              : {assessment.summary.unsafe_record_ids.join(", ")}
            </p>
          )}
          {assessment.records.map((record) => {
            const original = saved.evidenceBundle!.records.find(
              (row) => row.id === record.evidence_id,
            )!;
            const selected =
              record.canonical_selector_key === null
                ? undefined
                : original.parameters[record.canonical_selector_key];
            return (
              <details key={record.evidence_id} className="rounded-md border border-zinc-800 p-3">
                <summary className="cursor-pointer break-words text-zinc-300">
                  {record.tool} · {identityAlignment(record.record_alignment, language)} ·{" "}
                  {record.evidence_id}
                </summary>
                <div className="mt-3 space-y-2 break-words">
                  <p>
                    {zh ? "已证明的外层选择参数" : "Proven outer selector"}:{" "}
                    {record.canonical_selector_key ?? (zh ? "无" : "none")} ={" "}
                    <code>
                      {selected === undefined
                        ? zh
                          ? "未保存"
                          : "not saved"
                        : JSON.stringify(selected)}
                    </code>{" "}
                    · {record.content_scope}
                  </p>
                  <p>
                    {zh ? "选择参数对照" : "Canonical selector alignment"}:{" "}
                    {identityAlignment(record.canonical_alignment, language)} ·{" "}
                    {record.canonical_reason} · {record.canonical_rule}
                  </p>
                  <p>
                    {zh ? "记录级结果" : "Record alignment"}:{" "}
                    {identityAlignment(record.record_alignment, language)} · {record.record_reason}
                  </p>
                  <p>
                    {zh
                      ? "额外选择参数键 / 写法中的显式场所"
                      : "Extra selector keys / explicit venue in notation"}
                    : {record.unexpected_selector_keys.join(", ") || "—"} /{" "}
                    {record.venue ?? (zh ? "未知" : "unknown")}
                  </p>
                  {record.sources.map((source) => (
                    <p key={source.source_index} className="break-all">
                      {zh ? "来源序号" : "Source index"}: {source.source_index} · {source.provider}{" "}
                      ·{" "}
                      {zh
                        ? "提供方请求：未知 · 实体：未知"
                        : "Provider request: unknown · entity: unknown"}{" "}
                      · SHA-256: {source.data_sha256 ?? (zh ? "未保存数据" : "no saved data")}
                    </p>
                  ))}
                </div>
              </details>
            );
          })}
          <details
            key={assessment.assessment_sha256}
            onToggle={(event) =>
              setOpenHash(event.currentTarget.open ? assessment.assessment_sha256 : undefined)
            }
            className="rounded-md border border-zinc-800 p-3"
          >
            <summary className="cursor-pointer break-all text-zinc-300">
              {zh ? "完整冻结附件 / 哈希绑定" : "Complete frozen attachment / hash bindings"} ·{" "}
              {assessment.assessment_sha256}
            </summary>
            {openHash === assessment.assessment_sha256 && (
              <pre className="mt-3 max-h-96 overflow-auto whitespace-pre-wrap break-all">
                {JSON.stringify(assessment, null, 2)}
              </pre>
            )}
          </details>
        </div>
      )}
    </section>
  );
}
