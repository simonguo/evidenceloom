"use client";
import { useMemo, useState } from "react";
import type { EvidenceBundle } from "@/features/evidence/types";
import type { ContextBindings, ContextKey, ReportTextSnapshot, TextSpan } from "../types";
import type { NumericReviewDraft } from "../hooks/useNumericReview";
import { sectionKeys, numericPolicy } from "../lib/policy";
import { textareaSelectionSpan } from "../lib/spans";
import { sourceChoices, tableChoices } from "../lib/options";
import { numericContextLabels } from "../lib/presentation";
const inputClass = "w-full rounded-md border border-zinc-800 bg-zinc-950 p-2 text-sm text-zinc-200";
const buttonClass = "rounded border border-zinc-700 px-3 py-2 text-xs text-zinc-300 disabled:opacity-40";
export function NumericReviewForm({ snapshot, evidence, versionId, zh, pending, onCompare, onInvalidate }: {
    snapshot: ReportTextSnapshot;
    evidence: EvidenceBundle;
    versionId: string;
    zh: boolean;
    pending: boolean;
    onCompare: (draft: NumericReviewDraft) => Promise<void>;
    onInvalidate: () => void;
}) {
    const [sectionKey, setSectionKey] = useState("market_report"), [selected, setSelected] = useState<TextSpan | null>(null), [numericSpan, setNumericSpan] = useState<TextSpan | null>(null);
    const [contexts, setContexts] = useState<ContextBindings>({ instrument: null, row_date: null, units: null });
    const [sourceKey, setSourceKey] = useState(""), [pathIndex, setPathIndex] = useState(0), [rowDate, setRowDate] = useState(""), [field, setField] = useState("Close"), [places, setPlaces] = useState(2);
    const choices = useMemo(() => evidence ? sourceChoices(evidence) : [], [evidence]);
    const source = choices.find((choice) => choice.key === sourceKey) ?? choices[0];
    const path = numericPolicy.table_paths[pathIndex];
    const options = useMemo(() => source ? tableChoices(evidence, source.recordId, source.index, path) : { dates: [], fields: [] }, [evidence, source, path]);
    const presentSections = sectionKeys.filter((key) => snapshot?.report_sections[key] !== null && snapshot?.report_sections[key] !== undefined);
    const activeSection = presentSections.includes(sectionKey) ? sectionKey : presentSections[0] ?? sectionKey;
    const section = snapshot?.report_sections[activeSection] ?? "";
    const contextLabels = numericContextLabels(zh);
    const date = rowDate || options.dates[0] || "", column = field || options.fields[0] || "";
    const bind = (key: ContextKey) => { if (selected) {
        setContexts((current) => ({ ...current, [key]: selected }));
        onInvalidate();
    } };
    return <div className="mt-3 space-y-3">
          <label className="block text-xs text-zinc-400">{zh ? "冻结的报告章节" : "Frozen report section"}<select aria-label="Frozen report section" className={inputClass} value={activeSection} onChange={(event) => { setSectionKey(event.target.value); setSelected(null); setNumericSpan(null); setContexts({ instrument: null, row_date: null, units: null }); onInvalidate(); }}>{presentSections.map((key) => <option key={key} value={key}>{key}</option>)}</select>
    </label>
          <label className="block text-xs text-zinc-400">{zh ? "只读原文（选择数值或要绑定的文本）" : "Read-only original text (select a number or literal to bind)"}<textarea aria-label="Read-only original report text" readOnly value={section} rows={10} className={`${inputClass} font-mono`} onSelect={(event) => { const area = event.currentTarget; if (area.selectionStart !== area.selectionEnd) {
        try {
            setSelected(textareaSelectionSpan(section, area.selectionStart, area.selectionEnd));
        }
        catch {
            setSelected(null);
        }
    } }}/>
    </label>
          <p className="text-xs text-zinc-500">{zh ? "显示区统一换行；审阅绑定保留原始换行和 UTF-8 字节。" : "The display normalizes line endings; review bindings retain original line endings and UTF-8 bytes."}</p>
          <p className="break-all text-xs text-zinc-500">{zh ? "当前选择" : "Current selection"}: {selected?.text ?? "—"}</p>
          <button className={buttonClass} disabled={!selected} onClick={() => { setNumericSpan(selected); onInvalidate(); }}>{zh ? "设为所选数值" : "Use as selected number"}</button>
          <p className="text-xs text-zinc-400">{zh ? "所选数值" : "Selected number"}: {numericSpan?.text ?? "—"}</p>
          <div className="flex flex-wrap gap-2">{(["instrument", "row_date", "units"] as ContextKey[]).map((key) => <div key={key}>
    <button className={buttonClass} disabled={!selected} onClick={() => bind(key)}>{zh ? "绑定原文" : "Bind literal"} {contextLabels[key]}</button>
    <span className="ml-2 text-xs text-zinc-500">{contexts[key]?.text ?? (zh ? "未审阅" : "unreviewed")}</span>{contexts[key] && <button className="ml-2 text-xs text-zinc-500" onClick={() => { setContexts((current) => ({ ...current, [key]: null })); onInvalidate(); }}>{zh ? "清除" : "Clear"}</button>}</div>)}</div>
          <label className="block text-xs text-zinc-400">{zh ? "保存的证据来源" : "Saved evidence source"}<select aria-label="Saved evidence source" className={inputClass} value={source?.key ?? ""} onChange={(event) => { setSourceKey(event.target.value); setRowDate(""); onInvalidate(); }}>{choices.map((choice) => <option key={choice.key} value={choice.key}>{choice.label}</option>)}</select>
    </label>
          <label className="block text-xs text-zinc-400">{zh ? "保存表位置" : "Saved table path"}<select aria-label="Saved table path" className={inputClass} value={pathIndex} onChange={(event) => { setPathIndex(Number(event.target.value)); setRowDate(""); onInvalidate(); }}>{numericPolicy.table_paths.map((item, index) => <option key={index} value={index}>{item.length ? item.join(".") : "root"}</option>)}</select>
    </label>
          <div className="grid gap-3 sm:grid-cols-3">
    <label className="text-xs text-zinc-400">{zh ? "保存的日期标记" : "Saved date label"}<input aria-label="Saved date label" className={inputClass} list={`numeric-dates-${versionId}`} value={date} onChange={(event) => { setRowDate(event.target.value); onInvalidate(); }}/>
    <datalist id={`numeric-dates-${versionId}`}>{options.dates.map((item) => <option key={item} value={item}/>)}</datalist>
    </label>
    <label className="text-xs text-zinc-400">{zh ? "保存字段" : "Saved field"}<input aria-label="Saved field" className={inputClass} list={`numeric-fields-${versionId}`} value={column} onChange={(event) => { setField(event.target.value); onInvalidate(); }}/>
    <datalist id={`numeric-fields-${versionId}`}>{options.fields.map((item) => <option key={item} value={item}/>)}</datalist>
    </label>
    <label className="text-xs text-zinc-400">{zh ? "声明 HALF-UP 小数位" : "Declared HALF-UP decimal places"}<select aria-label="Decimal places" className={inputClass} value={places} onChange={(event) => { setPlaces(Number(event.target.value)); onInvalidate(); }}>{Array.from({ length: 19 }, (_, index) => <option key={index} value={index}>{index}</option>)}</select>
    </label>
    </div>
          <p className="text-xs text-zinc-500">{zh ? "日期候选仅预览前100个保存标记；可输入确切标记。不会查询数据来源。" : "Date suggestions preview up to 100 saved labels; enter an exact label if needed. No source is queried."}</p>
          <button className={buttonClass} disabled={!numericSpan || !source || !date || !column || pending} onClick={() => { if (numericSpan && source)
        void onCompare({ sectionKey: activeSection, numericSpan, operand: { evidenceId: source.recordId, sourceIndex: source.index, selector: { kind: "table_cell", table_path: [...path], row_date: date, field: column } }, contexts, places }); }}>{zh ? "对照所选字段" : "Compare selected field"}</button>
        </div>;
}
