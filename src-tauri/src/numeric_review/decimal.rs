//! Bounded base-ten arithmetic over the original saved number lexeme.
//! No conversion to an IEEE-754 value occurs in this module.
use super::{ensure, Result};
use std::sync::OnceLock;

#[derive(Debug)]
pub(super) struct Decimal {
    negative: bool,
    digits: String,
    exponent: i32,
}

impl Decimal {
    pub(super) fn parse(raw: &str) -> Option<Self> {
        if raw.is_empty() || raw.len() > 256 || !raw.is_ascii() {
            return None;
        }
        static NUMBER: OnceLock<regex::Regex> = OnceLock::new();
        if !NUMBER
            .get_or_init(|| {
                regex::Regex::new(r"\A[+-]?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?(?:[eE][+-]?[0-9]+)?\z")
                    .expect("fixed decimal grammar")
            })
            .is_match(raw)
        {
            return None;
        }
        let (negative, unsigned) = if let Some(value) = raw.strip_prefix('-') {
            (true, value)
        } else if let Some(value) = raw.strip_prefix('+') {
            (false, value)
        } else {
            (false, raw)
        };
        let mut parts = unsigned.split(['e', 'E']);
        let mantissa = parts.next()?;
        let exponent = if let Some(exponent) = parts.next() {
            if parts.next().is_some() {
                return None;
            }
            let exponent_digits = exponent.strip_prefix(['+', '-']).unwrap_or(exponent);
            if exponent_digits.is_empty()
                || !exponent_digits.bytes().all(|byte| byte.is_ascii_digit())
            {
                return None;
            }
            let significant = exponent_digits.trim_start_matches('0');
            if significant.len() > 4 {
                return None;
            }
            let magnitude = if significant.is_empty() {
                0
            } else {
                significant.parse::<i32>().ok()?
            };
            let exponent = if exponent.starts_with('-') {
                -magnitude
            } else {
                magnitude
            };
            if !(-1024..=1024).contains(&exponent) {
                return None;
            }
            exponent
        } else {
            0
        };
        let mut parts = mantissa.split('.');
        let integral = parts.next()?;
        let fractional = parts.next().unwrap_or("");
        if parts.next().is_some()
            || (integral.is_empty() && fractional.is_empty())
            || !integral.bytes().all(|byte| byte.is_ascii_digit())
            || !fractional.bytes().all(|byte| byte.is_ascii_digit())
            || integral.len() + fractional.len() > 128
        {
            return None;
        }
        let mut digits = format!("{integral}{fractional}");
        let mut exponent = exponent - fractional.len() as i32;
        digits = digits.trim_start_matches('0').to_owned();
        if digits.is_empty() {
            return Some(Self {
                negative: false,
                digits: "0".into(),
                exponent: 0,
            });
        }
        while digits.ends_with('0') {
            digits.pop();
            exponent += 1;
        }
        Some(Self {
            negative,
            digits,
            exponent,
        })
    }

    pub(super) fn equal(&self, other: &Self) -> bool {
        self.negative == other.negative
            && self.digits == other.digits
            && self.exponent == other.exponent
    }

    // Derived fixed-point output can exceed the external 128-digit input bound.
    // Normalize it internally without admitting a larger user/source number.
    pub(super) fn equals_rounded(&self, rounded: &str) -> bool {
        if rounded.len() > 1200 {
            return false;
        }
        let (negative, magnitude) = rounded
            .strip_prefix('-')
            .map_or((false, rounded), |value| (true, value));
        let mut parts = magnitude.split('.');
        let integral = parts.next().unwrap_or("");
        let fractional = parts.next().unwrap_or("");
        if integral.is_empty()
            || parts.next().is_some()
            || !integral
                .bytes()
                .chain(fractional.bytes())
                .all(|byte| byte.is_ascii_digit())
        {
            return false;
        }
        let mut digits = format!("{integral}{fractional}")
            .trim_start_matches('0')
            .to_owned();
        let mut exponent = -(fractional.len() as i32);
        if digits.is_empty() {
            return self.digits == "0";
        }
        while digits.ends_with('0') {
            digits.pop();
            exponent += 1;
        }
        self.equal(&Self {
            negative,
            digits,
            exponent,
        })
    }

    pub(super) fn rounded(&self, places: usize) -> Result<String> {
        ensure(places <= 18)?;
        let shift = self.exponent + places as i32;
        let mut magnitude = if shift >= 0 {
            format!("{}{}", self.digits, "0".repeat(shift as usize))
        } else {
            let removed = (-shift) as usize;
            let kept = self.digits.len().saturating_sub(removed);
            let mut result = if kept == 0 {
                "0".into()
            } else {
                self.digits[..kept].to_owned()
            };
            if removed <= self.digits.len() && self.digits.as_bytes()[kept] >= b'5' {
                increment(&mut result);
            }
            result
        };
        let nonzero = magnitude.bytes().any(|byte| byte != b'0');
        if places > 0 {
            if magnitude.len() <= places {
                magnitude = format!("{}{}", "0".repeat(places + 1 - magnitude.len()), magnitude);
            }
            magnitude.insert(magnitude.len() - places, '.');
        }
        if self.negative && nonzero {
            magnitude.insert(0, '-');
        }
        Ok(magnitude)
    }
}

fn increment(value: &mut String) {
    let mut bytes = value.as_bytes().to_vec();
    for digit in bytes.iter_mut().rev() {
        if *digit == b'9' {
            *digit = b'0';
        } else {
            *digit += 1;
            *value = String::from_utf8(bytes).expect("decimal ASCII digits");
            return;
        }
    }
    bytes.insert(0, b'1');
    *value = String::from_utf8(bytes).expect("decimal ASCII digits");
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn independent_half_up_boundaries_carries_scientific_and_signed_zero() {
        for (raw, places, expected) in [
            ("1.005", 2, "1.01"),
            ("2.675", 2, "2.68"),
            ("-1.005", 2, "-1.01"),
            ("9.995", 2, "10.00"),
            ("-0.0001", 2, "0.00"),
            ("-0.0", 0, "0"),
            ("5e-3", 2, "0.01"),
            ("1e-7", 8, "0.00000010"),
            ("2.5e3", 2, "2500.00"),
            ("123.45678901234567", 14, "123.45678901234567"),
        ] {
            assert_eq!(
                Decimal::parse(raw).unwrap().rounded(places).unwrap(),
                expected
            );
        }
        assert!(Decimal::parse("1e1025").is_none());
        assert!(Decimal::parse(&"1".repeat(129)).is_none());
        assert!(Decimal::parse("1e99999999999999999999").is_none());
        assert!(Decimal::parse("NaN").is_none());
        assert!(Decimal::parse("1e-2147483648").is_none());
        assert!(Decimal::parse("01").is_none());
        assert!(Decimal::parse(".5").is_none());
        assert!(Decimal::parse("1.").is_none());
        assert!(Decimal::parse("1.010")
            .unwrap()
            .equal(&Decimal::parse("1.01").unwrap()));
        assert!(!Decimal::parse("1.014")
            .unwrap()
            .equal(&Decimal::parse("1.01").unwrap()));
        for (raw, places, zeroes) in [("1e127", 18, 127), ("1e128", 0, 128), ("1e1024", 18, 1024)] {
            let expected = format!(
                "1{}{}",
                "0".repeat(zeroes),
                if places == 0 {
                    String::new()
                } else {
                    format!(".{}", "0".repeat(places))
                }
            );
            let number = Decimal::parse(raw).unwrap();
            assert_eq!(number.rounded(places).unwrap(), expected);
            assert!(number.equals_rounded(&expected));
        }
        assert!(Decimal::parse("1e+00000001024").is_some());
    }
}
