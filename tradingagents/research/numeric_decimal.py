"""Bounded exact base-ten arithmetic for saved field review; no floats."""

from __future__ import annotations

import re

_NUMBER = re.compile(r"([+-]?)(0|[1-9][0-9]*)(?:\.([0-9]+))?(?:[eE]([+-]?[0-9]+))?\Z")


def decimal_parts(text: str) -> tuple[int, int] | None:
    """Return signed coefficient and power, or unsupported (never coerce)."""
    if not isinstance(text, str) or len(text.encode("utf-8")) > 256:
        return None
    match = _NUMBER.fullmatch(text)
    if match is None:
        return None
    sign, integer, fraction, exponent = match.groups()
    digits = integer + (fraction or "")
    if len(digits) > 128:
        return None
    # Avoid converting arbitrary exponent lengths even for all-zero values.
    exponent_digits = (exponent or "0").lstrip("+-").lstrip("0") or "0"
    if len(exponent_digits) > 4:
        return None
    power = int(exponent or "0")
    if abs(power) > 1024:
        return None
    coefficient = int(digits) * (-1 if sign == "-" else 1)
    return coefficient, power - len(fraction or "")


def round_saved_decimal(text: str, places: int) -> str | None:
    """HALF-UP (ties away from zero); fixed places and positive rounded zero."""
    if type(places) is not int or not 0 <= places <= 18:
        return None
    parts = decimal_parts(text)
    if parts is None:
        return None
    coefficient, power = parts
    shift = power + places
    unsigned = abs(coefficient)
    if shift >= 0:
        rounded = unsigned * 10**shift
    else:
        divisor = 10 ** (-shift)
        rounded, remainder = divmod(unsigned, divisor)
        if remainder * 2 >= divisor:
            rounded += 1
    digits = str(rounded).rjust(places + 1, "0")
    result = digits if places == 0 else digits[:-places] + "." + digits[-places:]
    return ("-" if coefficient < 0 and rounded else "") + result


def equal_decimal(left: str, right: str) -> bool:
    """Compare a supported input with a bounded internally rounded decimal.

    Quantization can expand a supported exponent into more than 128 digits;
    the generated result must not be reclassified by the external input cap.
    """
    a = decimal_parts(left)
    if a is None or not isinstance(right, str) or len(right) > 1200:
        return False
    match = re.fullmatch(r"(-?)([0-9]+)(?:\.([0-9]+))?", right)
    if match is None:
        return False
    sign, integer, fraction = match.groups()
    b = (int(integer + (fraction or "")) * (-1 if sign else 1), -len(fraction or ""))
    ac, ap = a
    bc, bp = b
    common = min(ap, bp)
    return ac * 10 ** (ap - common) == bc * 10 ** (bp - common)
