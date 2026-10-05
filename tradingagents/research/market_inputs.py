"""Pure offline proof of saved provider rows behind a market assessment.

No library, provider or model computes a new observation here. Each enriched
same-provider table must support the claimed counts, labels and completion.
Additional invalid observations discarded by a loader may only increase the
saved invalid count; they can never add valid or completed inputs.
"""

from __future__ import annotations

from datetime import date, datetime, timedelta, timezone
import json
import math
import re
from zoneinfo import ZoneInfo, ZoneInfoNotFoundError

ERROR = "Saved market observations do not support the quality assessment"
# Exact observed-name registry v1. An unfamiliar alias remains unknown; this
# list never assigns a market timezone from an instrument or an offset.
CANONICAL_SOURCE_TIMEZONES = frozenset(
    {
        "UTC",
        "Etc/UTC",
        "America/New_York",
        "America/Chicago",
        "America/Denver",
        "America/Los_Angeles",
        "America/Toronto",
        "America/Vancouver",
        "Asia/Shanghai",
        "Asia/Hong_Kong",
        "Asia/Tokyo",
        "Asia/Seoul",
        "Asia/Singapore",
        "Asia/Taipei",
        "Asia/Kolkata",
        "Asia/Calcutta",
        "Europe/London",
        "Europe/Paris",
        "Europe/Berlin",
        "Europe/Zurich",
        "Europe/Amsterdam",
        "Europe/Brussels",
        "Europe/Madrid",
        "Europe/Rome",
        "Europe/Stockholm",
        "Europe/Oslo",
        "Europe/Copenhagen",
        "Europe/Helsinki",
        "Europe/Vienna",
        "Europe/Lisbon",
        "Europe/Istanbul",
        "Australia/Sydney",
        "Australia/Melbourne",
        "Australia/Perth",
        "Pacific/Auckland",
        "Africa/Johannesburg",
    }
)
_FIELDS = ("Open", "High", "Low", "Close", "Volume")
_SOURCE = ("SourceTimestamp", "SourceTimezone", "SourceUTCOffset", "TimezoneOrigin")
_REQUIRED = frozenset(("Date", *_FIELDS, *_SOURCE))
_COLUMNS = _REQUIRED | {"HistoryRequestStart", "HistoryRequestEnd", "PriceBasis"}
_ORIGINS = {"timestamp", "provider_metadata", "symbol_market_convention", "unknown"}
_MAX_NUMBER = 2**53 - 1
_DAY = re.compile(r"[0-9]{4}-[0-9]{2}-[0-9]{2}\Z")
_OFFSET = re.compile(r"([+-])([0-9]{2}):([0-9]{2})\Z")
_STAMP = re.compile(
    r"([0-9]{4}-[0-9]{2}-[0-9]{2})T([0-9]{2}):([0-9]{2}):([0-9]{2})"
    r"(?:\.([0-9]{1,9}))?(Z|[+-][0-9]{2}:[0-9]{2})?\Z"
)


def _fail():
    raise ValueError(ERROR)


def _require(condition):
    if not condition:
        _fail()


def _object(pairs):
    result = {}
    for key, value in pairs:
        _require(key not in result)
        result[key] = value
    return result


def _json(payload):
    return json.loads(payload, object_pairs_hook=_object, parse_constant=lambda _: _fail())


def _day(value):
    _require(isinstance(value, str) and _DAY.fullmatch(value) is not None)
    return date.fromisoformat(value)


def _offset(value):
    _require(isinstance(value, str))
    match = _OFFSET.fullmatch(value)
    _require(match is not None)
    hours, minutes = int(match[2]), int(match[3])
    _require(hours <= 14 and minutes <= 59 and not (hours == 14 and minutes))
    _require(value != "-00:00")
    return timedelta(minutes=(hours * 60 + minutes) * (1 if match[1] == "+" else -1))


def source_timezone_tzinfo(value):
    """Parse an exact admitted observed zone or canonical UTC offset.

    Used by the producer and offline proof, without ticker-based inference.
    The canonical offset range is ±14:00 and excludes negative zero.
    """
    if value == "UTC":
        return timezone.utc
    if isinstance(value, str) and value.startswith("UTC"):
        return timezone(_offset(value[3:]))
    _require(isinstance(value, str) and value in CANONICAL_SOURCE_TIMEZONES)
    return ZoneInfo(value)


def _number(value):
    if type(value) not in {int, float}:
        return None
    try:
        # Keep the exact payload unchanged, while bounding arithmetic shared
        # with f64 consumers so distinct large integers cannot collapse.
        return value if math.isfinite(value) and abs(value) <= _MAX_NUMBER else None
    except OverflowError:
        return None


def _valid(row):
    values = [_number(row[field]) for field in _FIELDS]
    if any(value is None for value in values):
        return False
    opened, high, low, close, volume = values
    return (
        min(opened, high, low, close) > 0
        and volume >= 0
        and high >= max(opened, close, low)
        and low <= min(opened, close, high)
    )


def _signature(row):
    # bool is an int subclass in Python; it is never a numeric observation.
    # Finite int/float values otherwise share the same numeric identity.
    return tuple(
        ("boolean", value) if type(value) is bool else value
        for value in (row[field] for field in (*_FIELDS, *_SOURCE))
    )


def _stamp(row):
    """Return the original source-zone clock, or unknown metadata.

    Invalid timezone metadata cannot establish completion. Unknown/mixed
    source clocks remain visible in an honest unknown quality assessment.
    """
    value = row["SourceTimestamp"]
    match = _STAMP.fullmatch(value) if isinstance(value, str) else None
    _require(match is not None)
    if match[6] and match[6] != "Z":
        _offset(match[6])
    stamp = datetime.fromisoformat(value.replace("Z", "+00:00"))
    zone_name = row["SourceTimezone"]
    offset_value = row["SourceUTCOffset"]
    origin = row["TimezoneOrigin"]
    _require(origin in _ORIGINS)
    try:
        zone = source_timezone_tzinfo(zone_name)
    except (ValueError, ZoneInfoNotFoundError, TypeError):
        return None, match
    if stamp.tzinfo is not None:
        _require(offset_value is not None and _offset(offset_value) == stamp.utcoffset())
        converted = stamp.astimezone(zone)
        _require(converted.replace(tzinfo=None) == stamp.replace(tzinfo=None))
        stamp = converted
    else:
        _require(offset_value is None and origin != "timestamp")
        # Ambiguous/nonexistent original local labels cannot establish a bar.
        stamp = stamp.replace(tzinfo=zone)
        _require(stamp.replace(fold=1).utcoffset() == stamp.utcoffset())
        _require(
            stamp.astimezone(timezone.utc).astimezone(zone).replace(tzinfo=None)
            == stamp.replace(tzinfo=None)
        )
    return stamp, match


def _state(row, observed, source_timezone):
    stamp, match = _stamp(row)
    if not source_timezone or row["TimezoneOrigin"] not in {"timestamp", "provider_metadata"}:
        return "unknown"
    if stamp is None:
        return "unknown"
    fraction = match[5] or ""
    if any((int(match[2]), int(match[3]), int(match[4]))) or any(ch != "0" for ch in fraction):
        return "provisional"
    if stamp.date() >= observed.date() or stamp.date() >= observed.astimezone(stamp.tzinfo).date():
        return "provisional"
    return "complete_provider_daily_rows"


def _table(payload):
    if not isinstance(payload, dict) or set(payload) != {"columns", "rows"}:
        return None
    columns, rows = payload["columns"], payload["rows"]
    if not isinstance(columns, list) or not all(isinstance(column, str) for column in columns):
        return None
    if not _REQUIRED.issubset(columns):
        return None
    _require(len(columns) == len(set(columns)) and set(columns).issubset(_COLUMNS))
    _require(isinstance(rows, list) and 0 < len(rows) <= 1000000)
    result = []
    for values in rows:
        _require(isinstance(values, list) and len(values) == len(columns))
        _require(all(value is None or type(value) in {str, int, float, bool} for value in values))
        row = dict(zip(columns, values))
        # Reject unsupported numeric tables before duplicate comparisons: f64
        # JSON parsers can otherwise collapse distinct large integer labels.
        _require(
            all(
                type(row[field]) not in {int, float} or abs(row[field]) <= _MAX_NUMBER
                for field in _FIELDS
            )
        )
        result.append(row)
    return result


def _proof(quality, source, rows):
    counts = quality["rows"]
    _require(counts["in_window"] == len(rows))
    _require(counts["received"] >= len(rows))
    observed = datetime.fromisoformat(quality["observed_at"].replace("Z", "+00:00"))
    _require(observed.tzinfo is not None and observed.utcoffset() == timedelta(0))
    requested = quality["requested_window"]
    end = _day(requested["end"])
    start = _day(requested["start"]) if requested["start"] is not None else None
    _require(end <= _day(quality["analysis_date"]) and (start is None or start <= end))
    window = source["observed_window"]
    _require(isinstance(window, dict) and set(window) == {"start", "end"})
    saved_start, saved_end = _day(window["start"]), _day(window["end"])
    if "PriceBasis" in rows[0] and quality["price_basis"]["status"] == "observed":
        _require({row["PriceBasis"] for row in rows} == {quality["price_basis"]["value"]})
    if "HistoryRequestStart" in rows[0]:
        starts = {row["HistoryRequestStart"] for row in rows}
        _require(len(starts) == 1 and requested["start"] == next(iter(starts)))
        _day(next(iter(starts)))
    if "HistoryRequestEnd" in rows[0]:
        ends = {row["HistoryRequestEnd"] for row in rows}
        _require(len(ends) == 1 and _day(next(iter(ends))) > end)
    groups = {}
    for row in rows:
        # The normalized working date must retain the original civil label.
        label_value = row["Date"]
        label = _day(label_value[:10] if isinstance(label_value, str) else None)
        if len(label_value) > 10:
            working = _STAMP.fullmatch(label_value)
            _require(working is not None and not working[6])
            _require(not any(char != "0" for char in working[5] or ""))
            normalized = datetime.fromisoformat(label_value)
            _require(normalized.tzinfo is None and normalized.time() == datetime.min.time())
        stamp, match = _stamp(row)
        _require(_day(match[1]) == label)
        _require((start is None or label >= start) and label <= end)
        _require(saved_start <= label <= saved_end)
        groups.setdefault(label, []).append(row)
    labels = sorted(groups)
    _require(labels[0] == saved_start and labels[-1] == saved_end)
    _require(counts["latest_received_date"] == labels[-1].isoformat())
    valid, conflicts, collapsed = [], [], 0
    for label in labels:
        group = groups[label]
        signatures = {_signature(row) for row in group}
        if len(signatures) > 1:
            conflicts.append(label.isoformat())
        else:
            collapsed += len(group) - 1
            if _valid(group[0]):
                valid.append(group[0])
    _require(counts["valid"] == len(valid))
    _require(counts["identical_duplicates_collapsed"] == collapsed)
    _require(counts["conflicting_duplicate_dates"] == conflicts)
    invalid = len(rows) - len(valid) - collapsed
    _require(invalid <= counts["invalid"] <= invalid + counts["received"] - len(rows))
    _require(
        quality["integrity_status"]
        == ("invalid" if counts["invalid"] else "valid" if valid else "empty")
    )
    zones = {
        row["SourceTimezone"]
        for row in valid
        if isinstance(row["SourceTimezone"], str) and row["SourceTimezone"]
    }
    origins = {row["TimezoneOrigin"] for row in valid}
    zone_name = next(iter(zones)) if len(zones) == 1 else None
    origin = (
        "provider_metadata"
        if "provider_metadata" in origins
        else "timestamp"
        if origins == {"timestamp"}
        else "symbol_market_convention"
        if origins == {"symbol_market_convention"}
        else "unknown"
    )
    stamps = [_stamp(row)[0] for row in valid]
    if not zone_name or not any(stamp is not None for stamp in stamps):
        zone_name, origin = None, "unknown"
    _require(quality["source_timezone"] == zone_name and quality["timezone_origin"] == origin)
    states = [_state(row, observed, zone_name) for row in valid]
    complete = [row for row, state in zip(valid, states) if state == "complete_provider_daily_rows"]
    _require(counts["usable_complete"] == len(complete))
    _require(counts["provisional"] == states.count("provisional"))
    _require(counts["unknown_completion"] == states.count("unknown"))
    latest = complete[-1]["SourceTimestamp"][:10] if complete else None
    _require(counts["latest_usable_date"] == latest)
    status = (
        (
            "provisional"
            if "provisional" in states
            else "unknown"
            if "unknown" in states
            else "empty"
        )
        if not complete
        else states[-1]
    )
    _require(quality["completion_status"] == status)


def validate_market_observations(quality, record, evidence) -> None:
    """Reject contradictory quality using saved facts, without fetching data.

    At least one enriched table is required. Every enriched non-withheld table
    for the claimed provider must agree; intermediate adapter tables lacking
    source-clock columns do not establish completion. Errors are fixed text.
    """
    try:
        tables = []
        for source in record["sources"]:
            if (
                source["provider"] != quality["provider"]
                or source["historical_availability"] == "withheld"
            ):
                continue
            digest = source["data_sha256"]
            if digest is None:
                continue
            artifact = evidence["artifacts"][digest]
            _require(artifact["kind"] == "normalized_data")
            rows = _table(_json(artifact["payload"]))
            if rows is not None:
                tables.append((source, rows))
        _require(tables)
        for source, rows in tables:
            _proof(quality, source, rows)
    except (ValueError, TypeError, KeyError, OverflowError, AttributeError, RecursionError):
        raise ValueError(ERROR) from None
