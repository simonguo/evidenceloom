import type { SystemLanguage } from "@/lib/types";
import type { IdentityAlignment } from "../types";
export const identityTitle = (language: SystemLanguage) =>
  language === "zh" ? "保存的有效外层请求对照" : "Saved effective outer-request alignment";
export const identityNotice = (language: SystemLanguage) =>
  language === "zh"
    ? "只对照保存的外层工具选择参数与本次请求代码。提供方的实际请求和解析实体均未知；不确认场所、新闻或帖子主体、来源可靠性或金融事实，也不改变原报告、数值审阅或输入检查。"
    : "Only the saved outer tool selector is compared with the requested run identifier. Actual provider requests and resolved entities remain unknown. This does not confirm venue, article or post subjects, source reliability or financial truth, or change the report, numeric reviews or input checks.";
export const identityAbsent = (language: SystemLanguage) =>
  language === "zh"
    ? "此版本未保存请求对照附件；关系未知，不自动补评。"
    : "No request-alignment attachment was saved for this version; the relationship is unknown and is not assessed retroactively.";
export function identityAlignment(value: IdentityAlignment, language: SystemLanguage) {
  const zh: Record<IdentityAlignment, string> = {
    consistent: "请求字面量或已审阅写法一致",
    conflict: "请求字面量冲突",
    unknown: "请求关系未知",
    proxy: "声明的参考替代",
    not_applicable: "全局查询不适用",
  };
  const en: Record<IdentityAlignment, string> = {
    consistent: "Saved request literal or reviewed notation consistent",
    conflict: "Saved request literal conflict",
    unknown: "Request relationship unknown",
    proxy: "Declared reference substitution",
    not_applicable: "Global query not applicable",
  };
  return (language === "zh" ? zh : en)[value];
}
