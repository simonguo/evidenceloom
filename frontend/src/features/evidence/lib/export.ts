import type { EvidenceBundle, EvidenceValidation } from "../types";
import { copyEvidenceBundle, invalidEvidence } from "./validation";

export function exportEvidence(bundle: unknown, invalid?: EvidenceValidation): { bundle?: EvidenceBundle; invalid?: EvidenceValidation } {
  if (bundle === undefined) return { invalid };
  try { return { bundle: copyEvidenceBundle(bundle) }; }
  catch (error) { return { invalid: invalidEvidence(error) }; }
}
export function evidenceNotice(language: "zh" | "en") {
  return language === "zh"
    ? "引用解析只确认 ID 对应已保存来源，不证明事实支持或研究准确性。以下是本次研究保存的标准化输入，含完整精度数据与确切模型输入；第三方内容的再分发权利未得到确认。SHA-256 按规范 JSON 计算，用于检测内容更改。"
    : "Citation resolution confirms that an ID maps to a saved source; it does not prove factual support or research accuracy. This appendix contains the saved normalized research inputs, including full-precision data and exact model input. Redistribution rights for third-party content have not been established. SHA-256 over canonical JSON detects content changes.";
}
export function evidenceAbsent(language: "zh" | "en", invalid?: EvidenceValidation) {
  return invalid
    ? language === "zh" ? `证据包无效，无法导出已核验证据：${invalid.reason}` : `Invalid evidence bundle; verified evidence cannot be exported: ${invalid.reason}`
    : language === "zh" ? "此历史版本未保存证据包；来源、内容哈希和历史可用性未知。" : "No evidence bundle was saved for this version. Sources, content hashes, and historical availability are unknown.";
}
export function linkEvidenceCitations(content: string, bundle?: EvidenceBundle) {
  if (!bundle) return content;
  const ids = new Set(bundle.records.map((record) => record.id));
  return content.replace(/\[E:(ev-[a-f0-9]{32})\]/g, (full, id) => ids.has(id) ? `[${full.replaceAll("[", "\\[").replaceAll("]", "\\]")}](#${id})` : full);
}
