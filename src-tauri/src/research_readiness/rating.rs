//! The first explicit rating is authoritative, including compatibility text.
use regex::Regex;
use std::{collections::BTreeSet, sync::OnceLock};
use unicode_normalization::UnicodeNormalization;

const RATINGS: &[&str] = &["Buy", "Overweight", "Hold", "Underweight", "Sell", "REVIEW"];
const CHINESE: &[(&str, &str)] = &[
    ("买入", "Buy"),
    ("看多", "Buy"),
    ("超配", "Overweight"),
    ("增持", "Overweight"),
    ("加仓", "Overweight"),
    ("持有", "Hold"),
    ("观望", "Hold"),
    ("中性", "Hold"),
    ("低配", "Underweight"),
    ("减持", "Underweight"),
    ("卖出", "Sell"),
    ("清仓", "Sell"),
    ("看空", "Sell"),
    ("待复核", "REVIEW"),
];
fn normalize(value: &str) -> Option<&'static str> {
    RATINGS
        .iter()
        .copied()
        .find(|rating| value.eq_ignore_ascii_case(rating))
}
fn python_space(value: char) -> bool {
    value.is_whitespace() || ('\u{1c}'..='\u{1f}').contains(&value)
}
fn python_word(value: char) -> bool {
    // Python's Unicode \w is letters/numbers/underscore; Rust's \w also
    // includes combining marks, which must not hide the first explicit call.
    static WORD: OnceLock<Regex> = OnceLock::new();
    WORD.get_or_init(|| Regex::new(r"^[\p{L}\p{N}_]$").expect("fixed Python word class"))
        .is_match(value.encode_utf8(&mut [0; 4]))
}
fn token_boundary(text: &str, start: usize, end: usize) -> bool {
    text[..start]
        .chars()
        .next_back()
        .is_none_or(|value| !python_word(value))
        && text[end..]
            .chars()
            .next()
            .is_none_or(|value| !python_word(value))
}
pub(super) fn extract(text: &str) -> Option<&'static str> {
    static PATTERNS: OnceLock<(Regex, Regex, Regex, Regex)> = OnceLock::new();
    let (line_pattern, value_pattern, english_pattern, explanation_pattern) = PATTERNS.get_or_init(|| (
        Regex::new(r"(?i)^[\s\x{1c}-\x{1f}]*(?:\d+[.)][\s\x{1c}-\x{1f}]+)?[*_#\s\x{1c}-\x{1f}]*(?:(?:f[iİı]nal|our)[\s\x{1c}-\x{1f}]+rat[iİı]ng|rat[iİı]ng|(?:最终|建议|组合)?评级|最终(?:交易)?决策|交易决策|决策|建议)[*_\s\x{1c}-\x{1f}]*[:\-\x{2010}-\x{2015}][*_\s\x{1c}-\x{1f}]*(.+)$").expect("fixed rating line"),
        Regex::new(r"(?i)^(Buy|Overwe[iİı]ght|Hold|Underwe[iİı]ght|Sell|REV[iİı]EW)").expect("fixed rating value"),
        Regex::new(r"(?i)(Buy|Overwe[iİı]ght|Hold|Underwe[iİı]ght|Sell|REV[iİı]EW)").expect("fixed rating alternatives"),
        Regex::new(r"[\s\x{1c}-\x{1f}]+[\-\x{2013}\x{2014}][\s\x{1c}-\x{1f}]+|[:：;；.。]").expect("fixed rating explanation"),
    ));
    let normalized: String = text.nfkc().collect();
    for line in normalized.split([
        '\n', '\r', '\u{b}', '\u{c}', '\u{85}', '\u{2028}', '\u{2029}', '\u{1c}', '\u{1d}',
        '\u{1e}',
    ]) {
        let Some(capture) = line_pattern.captures(line) else {
            continue;
        };
        let value = capture[1].trim_matches(python_space);
        let clause = explanation_pattern.split(value).next().unwrap_or_default();
        let mut ratings: BTreeSet<_> = english_pattern
            .captures_iter(clause)
            .filter(|capture| {
                let found = capture.get(1).unwrap();
                token_boundary(clause, found.start(), found.end())
            })
            .map(|capture| normalize(&capture[1]))
            .collect();
        ratings.extend(
            CHINESE
                .iter()
                .filter_map(|(label, rating)| clause.contains(label).then_some(Some(*rating))),
        );
        if ratings.len() > 1 {
            return None;
        }
        if let Some(english) = value_pattern.captures(value) {
            if token_boundary(value, 0, english.get(1).unwrap().end()) {
                return normalize(&english[1]);
            }
        }
        if let Some((_, rating)) = CHINESE.iter().find(|(label, _)| value.starts_with(label)) {
            return Some(rating);
        }
    }
    None
}

#[cfg(test)]
mod tests {
    use super::extract;
    #[test]
    fn first_authoritative_rating_includes_unicode_and_rejects_alternatives() {
        assert_eq!(extract("Rating: Buy\nRating: REVIEW"), Some("Buy"));
        assert_eq!(
            extract("Ｒａｔｉｎｇ： Ｂｕｙ\nRating: REVIEW"),
            Some("Buy")
        );
        assert_eq!(
            extract("1. **最终评级**： 待复核 — input unavailable"),
            Some("REVIEW")
        );
        assert_eq!(extract("> Rating: Buy\nRating: REVIEW"), Some("REVIEW"));
        assert_eq!(extract("Rating: REVIEW or Buy\nRating: REVIEW"), None);
        assert_eq!(
            extract("Rating: REVIEW — earlier thesis proposed Buy"),
            Some("REVIEW")
        );
        assert_eq!(extract("Rating: 待复核 / 买入\nRating: REVIEW"), None);
        for text in [
            "Ratİng: Buy\nRating: REVIEW",
            "Ratıng: Buy\nRating: REVIEW",
            "Rating: Buy\u{338}\nRating: REVIEW",
            "\u{1f}Rating: Buy\nRating: REVIEW",
        ] {
            assert_eq!(extract(text), Some("Buy"), "{text}");
        }
        assert_eq!(extract("Rating: Hold\u{338}\nRating: REVIEW"), Some("Hold"));
        assert_eq!(extract("Rating: REVİEW\nRating: REVIEW"), None);
        assert_eq!(extract("Rating: REVIEW or REVİEW\nRating: REVIEW"), None);
        assert_eq!(extract("Rating: Buy中文\nRating: REVIEW"), Some("REVIEW"));
        assert_eq!(
            extract("Rating: Buy\u{301}\nRating: REVIEW"),
            Some("REVIEW")
        );
        assert_eq!(extract("١. **Rating:** Buy\nRating: REVIEW"), Some("Buy"));
        assert_eq!(extract("Rating: Overweİght\nRating: REVIEW"), None);
    }
}
