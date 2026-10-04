//! Original UTF-8 byte spans; displayed Markdown is never used as authority.
use super::{ensure, exact, string, Result};
use std::sync::OnceLock;

pub(super) fn text<'a>(
    section: &'a str,
    span: &serde_json::Value,
) -> Result<(&'a str, &'a str, &'a str)> {
    exact(span, &["start_byte", "end_byte", "text"])?;
    let start = span["start_byte"]
        .as_u64()
        .and_then(|value| usize::try_from(value).ok())
        .ok_or(super::ERROR)?;
    let end = span["end_byte"]
        .as_u64()
        .and_then(|value| usize::try_from(value).ok())
        .ok_or(super::ERROR)?;
    ensure(
        start < end
            && end <= section.len()
            && section.is_char_boundary(start)
            && section.is_char_boundary(end),
    )?;
    ensure(&section[start..end] == string(&span["text"])?)?;
    Ok((&section[start..end], &section[..start], &section[end..]))
}

fn number(value: char) -> bool {
    static NUMBER: OnceLock<regex::Regex> = OnceLock::new();
    NUMBER
        .get_or_init(|| regex::Regex::new(r"\A\p{N}\z").expect("Unicode number category"))
        .is_match(&value.to_string())
}
fn scaled(value: &str) -> bool {
    let value = value.trim_start_matches([' ', '\t']);
    if value.starts_with(['%', '‰', '‱', '％', '٪', '千', '万', '亿', '萬', '億', '兆'])
    {
        return true;
    }
    let value = value.to_ascii_lowercase();
    [
        "k", "m", "b", "t", "bp", "bps", "million", "billion", "trillion",
    ]
    .iter()
    .any(|prefix| {
        value.strip_prefix(prefix).is_some_and(|tail| {
            tail.chars()
                .next()
                .is_none_or(|value| value != '_' && !value.is_ascii_alphanumeric())
        })
    })
}

pub(super) fn supported(section: &str, span: &serde_json::Value) -> Result<bool> {
    let (selected, prefix, suffix) = text(section, span)?;
    static TOKEN: OnceLock<regex::Regex> = OnceLock::new();
    let matched = TOKEN
        .get_or_init(|| {
            regex::Regex::new(r"[+-]?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?(?:[eE][+-]?[0-9]+)?")
                .expect("fixed numeric token")
        })
        .find_iter(section)
        .any(|found| found.start() == prefix.len() && found.end() == prefix.len() + selected.len());
    if !matched {
        return Ok(false);
    }
    let before = prefix.chars().next_back();
    let after = suffix.chars().next();
    if before.is_some_and(|value| ['.', '٫', '．'].contains(&value)) {
        return Ok(false);
    }
    if before.is_some_and(|value| {
        ['-', '+', '−', '﹣', '－', '＋', '﹢', '±', '_'].contains(&value) || number(value)
    }) || after.is_some_and(|value| ['_', 'e', 'E'].contains(&value) || number(value))
    {
        return Ok(false);
    }
    let separator = |value| {
        [
            '.', ',', '٫', '٬', '．', '，', '\u{a0}', '\u{202f}', '\u{2009}',
        ]
        .contains(&value)
    };
    if before.is_some_and(separator) && prefix.chars().rev().nth(1).is_some_and(number)
        || after.is_some_and(separator) && suffix.chars().nth(1).is_some_and(number)
    {
        return Ok(false);
    }
    Ok(!scaled(suffix))
}

pub(super) fn supported_context(section: &str, span: &serde_json::Value) -> Result<bool> {
    let (_, prefix, suffix) = text(section, span)?;
    let part = |value: char| value == '_' || value.is_ascii_alphanumeric();
    Ok(!prefix.chars().next_back().is_some_and(part) && !suffix.chars().next().is_some_and(part))
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    fn select(section: &str, selected: &str) -> serde_json::Value {
        let start = section.find(selected).unwrap();
        json!({"start_byte":start,"end_byte":start+selected.len(),"text":selected})
    }
    #[test]
    fn exact_unicode_crlf_and_complete_tokens_have_independent_expectations() {
        let section = "😀证券 FICT e\u{301}\r\n收盘1.01元";
        let span = select(section, "1.01");
        assert_eq!(text(section, &span).unwrap().0, "1.01");
        assert!(supported(section, &span).unwrap());
        assert!(text(section, &json!({"start_byte":1,"end_byte":2,"text":""})).is_err());
        for (section, selected) in [
            ("-1.01", "1.01"),
            ("1.01", "1.0"),
            ("1e-07", "1"),
            ("1,000", "000"),
            ("1\u{202f}000", "1"),
            ("١1", "1"),
            ("1%", "1"),
            ("1 MILLION", "1"),
            ("1万", "1"),
            ("1萬", "1"),
            ("1億", "1"),
            ("100％", "100"),
            ("100٪", "100"),
            ("100‱", "100"),
            ("．5", "5"),
            ("٫5", "5"),
            (".5", "5"),
            ("1，125.02", "125.02"),
            ("1．125.02", "1"),
            ("﹢125.02", "125.02"),
            ("±125.02", "125.02"),
            ("1.01_", "1.01"),
        ] {
            assert!(
                !supported(section, &select(section, selected)).unwrap(),
                "{section}"
            );
        }
        assert!(supported("1.01USD", &select("1.01USD", "1.01")).unwrap());
        assert!(!supported_context("OTHERFICT", &select("OTHERFICT", "FICT")).unwrap());
        assert!(supported_context("证券FICT", &select("证券FICT", "FICT")).unwrap());
    }
}
