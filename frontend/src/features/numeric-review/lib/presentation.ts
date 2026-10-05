export function numericContextLabels(zh: boolean) {
    return {
        instrument: zh ? "本次请求代码字面量" : "Requested run identifier literal",
        row_date: zh ? "日期字面量" : "Date literal",
        units: zh ? "单位字面量" : "Units literal",
    };
}
export function requestedIdentifierScope(zh: boolean) {
    return zh
        ? "本次请求代码字面量对照不验证工具参数或数据提供方解析的实体。"
        : "Requested run identifier literal comparisons do not verify tool parameters or the provider-resolved entity.";
}
