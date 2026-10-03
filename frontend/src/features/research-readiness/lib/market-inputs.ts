import type { EvidenceBundle, EvidenceRecord, EvidenceSource } from "@/features/evidence/types";
import { day, object, parsePayload } from "@/features/memory/lib/guards";
import type { MarketVerificationQuality } from "./quality";
import { assert } from "./validation-guards";

type Row = Record<string, unknown>;
type Zone = { offset: number } | { formatter: Intl.DateTimeFormat };
type Clock = { label: string; zone: Zone; provisional: boolean };
const prices = ["Open", "High", "Low", "Close", "Volume"];
const sourceFields = ["SourceTimestamp", "SourceTimezone", "SourceUTCOffset", "TimezoneOrigin"];
const required = ["Date", ...prices, ...sourceFields];
const columnsAllowed = new Set([...required, "HistoryRequestStart", "HistoryRequestEnd", "PriceBasis"]);
const origins = ["timestamp", "provider_metadata", "symbol_market_convention", "unknown"];
const zones = new Map<string, Zone | null>();
// Exact observed-name registry v1, shared with research/market_inputs.py.
// It admits observed clocks only; it never assigns a zone from an instrument.
const acceptedZones = new Set(["UTC", "Etc/UTC", "America/New_York", "America/Chicago", "America/Denver", "America/Los_Angeles", "America/Toronto", "America/Vancouver", "Asia/Shanghai", "Asia/Hong_Kong", "Asia/Tokyo", "Asia/Seoul", "Asia/Singapore", "Asia/Taipei", "Asia/Kolkata", "Asia/Calcutta", "Europe/London", "Europe/Paris", "Europe/Berlin", "Europe/Zurich", "Europe/Amsterdam", "Europe/Brussels", "Europe/Madrid", "Europe/Rome", "Europe/Stockholm", "Europe/Oslo", "Europe/Copenhagen", "Europe/Helsinki", "Europe/Vienna", "Europe/Lisbon", "Europe/Istanbul", "Australia/Sydney", "Australia/Melbourne", "Australia/Perth", "Pacific/Auckland", "Africa/Johannesburg"]);

function offset(value: unknown): number {
  assert(typeof value === "string"); const match = /^([+-])([0-9]{2}):([0-9]{2})$/.exec(value); assert(match);
  const hours = Number(match[2]), minutes = Number(match[3]);
  assert(hours <= 14 && minutes <= 59 && !(hours === 14 && minutes) && value !== "-00:00");
  return (hours * 60 + minutes) * 60_000 * (match[1] === "+" ? 1 : -1);
}
function zone(value: unknown): Zone | null {
  if (typeof value !== "string" || !value || value.length > 128) return null;
  if (zones.has(value)) return zones.get(value)!;
  let result: Zone | null = null;
  try {
    if (value === "UTC") result = { offset: 0 };
    else if (value.startsWith("UTC")) result = { offset: offset(value.slice(3)) };
    else {
      const formatter = new Intl.DateTimeFormat("en-CA", { timeZone: value, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23" });
      // Intl normalizes wrong-case zone names. Such strings do not prove the
      // exact, case-sensitive source zone recorded by Python's IANA registry.
      assert(acceptedZones.has(value));
      result = { formatter };
    }
  } catch { /* An unsupported source clock cannot establish completion. */ }
  zones.set(value, result); return result;
}
function parts(clock: Zone, milliseconds: number): string {
  if ("offset" in clock) return new Date(milliseconds + clock.offset).toISOString().slice(0, 19);
  const values = Object.fromEntries(clock.formatter.formatToParts(milliseconds).map((part) => [part.type, part.value]));
  return `${values.year.padStart(4, "0")}-${values.month}-${values.day}T${values.hour}:${values.minute}:${values.second}`;
}
function epoch(wall: string) { const value = Date.parse(`${wall}Z`); assert(Number.isFinite(value)); return value; }
function sourceClock(row: Row): Clock | null {
  const value = row.SourceTimestamp;
  assert(typeof value === "string");
  const match = /^([0-9]{4}-[0-9]{2}-[0-9]{2})T([0-9]{2}):([0-9]{2}):([0-9]{2})(?:\.([0-9]{1,9}))?(Z|[+-][0-9]{2}:[0-9]{2})?$/.exec(value);
  assert(match && day(match[1]) && Number(match[2]) < 24 && Number(match[3]) < 60 && Number(match[4]) < 60 && origins.includes(String(row.TimezoneOrigin)));
  const originalOffset = match[6] ? match[6] === "Z" ? 0 : offset(match[6]) : null;
  const clock = zone(row.SourceTimezone);
  if (!clock) return null;
  const wall = value.slice(0, 19), wallEpoch = epoch(wall);
  if (match[6]) {
    assert(row.SourceUTCOffset !== null);
    assert(originalOffset !== null && offset(row.SourceUTCOffset) === originalOffset && parts(clock, wallEpoch - originalOffset) === wall);
  } else {
    assert(row.SourceUTCOffset === null && row.TimezoneOrigin !== "timestamp");
    if ("offset" in clock) assert(parts(clock, wallEpoch - clock.offset) === wall);
    else {
      // Collect offsets on both sides of a possible clock transition. A local
      // label with zero or two realizations is not an unambiguous observation.
      const offsets = new Set<number>();
      for (const delta of [-172_800_000, -86_400_000, 0, 86_400_000, 172_800_000]) offsets.add(epoch(parts(clock, wallEpoch + delta)) - (wallEpoch + delta));
      assert([...offsets].filter((candidate) => parts(clock, wallEpoch - candidate) === wall).length === 1);
    }
  }
  return { label: match[1], zone: clock, provisional: [match[2], match[3], match[4]].some((part) => Number(part) !== 0) || /[1-9]/.test(match[5] ?? "") };
}
function valid(row: Row) {
  const values = prices.map((key) => row[key]);
  if (!values.every((value): value is number => typeof value === "number" && Number.isFinite(value) && Math.abs(value) <= Number.MAX_SAFE_INTEGER)) return false;
  const [open, high, low, close, volume] = values;
  return Math.min(open, high, low, close) > 0 && volume >= 0 && high >= Math.max(open, close, low) && low <= Math.min(open, close, high);
}
function table(value: unknown): Row[] | null {
  if (!object(value) || Object.keys(value).length !== 2 || !Object.hasOwn(value, "columns") || !Object.hasOwn(value, "rows") || !Array.isArray(value.columns) || !value.columns.every((column): column is string => typeof column === "string") || !required.every((column) => (value.columns as string[]).includes(column))) return null;
  const columns = value.columns;
  assert(new Set(columns).size === columns.length && columns.every((column) => columnsAllowed.has(column)));
  assert(Array.isArray(value.rows) && value.rows.length > 0 && value.rows.length <= 1_000_000);
  return value.rows.map((values) => {
    assert(Array.isArray(values) && values.length === columns.length && values.every((item) => item === null || ["string", "number", "boolean"].includes(typeof item)));
    const row = Object.fromEntries(columns.map((column, index) => [column, values[index]]));
    for (const key of prices) if (typeof row[key] === "number") assert(Number.isFinite(row[key]) && Math.abs(row[key]) <= Number.MAX_SAFE_INTEGER);
    return row;
  });
}
function signature(row: Row) { return JSON.stringify([...prices, ...sourceFields].map((key) => [typeof row[key], row[key]])); }
function proof(quality: MarketVerificationQuality, source: EvidenceSource, rows: Row[]) {
  const counts = quality.rows;
  assert(counts.in_window === rows.length && counts.received >= rows.length);
  const requested = quality.requested_window, window = source.observed_window;
  assert(window && day(window.start) && day(window.end));
  if (Object.hasOwn(rows[0], "PriceBasis") && quality.price_basis.status === "observed") assert(rows.every((row) => row.PriceBasis === quality.price_basis.value));
  if (Object.hasOwn(rows[0], "HistoryRequestStart")) assert(day(rows[0].HistoryRequestStart) && rows.every((row) => row.HistoryRequestStart === requested.start));
  if (Object.hasOwn(rows[0], "HistoryRequestEnd")) assert(day(rows[0].HistoryRequestEnd) && rows.every((row) => row.HistoryRequestEnd === rows[0].HistoryRequestEnd) && rows[0].HistoryRequestEnd > requested.end);
  const groups = new Map<string, Row[]>(), clocks = new Map<Row, Clock | null>();
  for (const row of rows) {
    assert(typeof row.Date === "string"); const label = row.Date.slice(0, 10); assert(day(label));
    if (row.Date.length > 10) assert(/^[0-9]{4}-[0-9]{2}-[0-9]{2}T00:00:00(?:\.0{1,9})?$/.test(row.Date));
    const clock = sourceClock(row); clocks.set(row, clock);
    assert(typeof row.SourceTimestamp === "string" && row.SourceTimestamp.slice(0, 10) === label);
    assert((requested.start === null || label >= requested.start) && label <= requested.end && label >= window.start && label <= window.end);
    const group = groups.get(label);
    if (group) group.push(row); else groups.set(label, [row]);
  }
  const labels = [...groups.keys()].sort();
  assert(labels[0] === window.start && labels.at(-1) === window.end && counts.latest_received_date === labels.at(-1));
  const validRows: Row[] = [], conflicts: string[] = []; let collapsed = 0;
  for (const label of labels) {
    const group = groups.get(label)!;
    if (new Set(group.map(signature)).size > 1) conflicts.push(label);
    else { collapsed += group.length - 1; if (valid(group[0])) validRows.push(group[0]); }
  }
  const invalid = rows.length - validRows.length - collapsed;
  assert(counts.valid === validRows.length && counts.identical_duplicates_collapsed === collapsed && JSON.stringify(counts.conflicting_duplicate_dates) === JSON.stringify(conflicts) && counts.invalid >= invalid && counts.invalid <= invalid + counts.received - rows.length);
  assert(quality.integrity_status === (counts.invalid ? "invalid" : validRows.length ? "valid" : "empty"));
  const names = new Set(validRows.flatMap((row) => typeof row.SourceTimezone === "string" && row.SourceTimezone ? [row.SourceTimezone] : []));
  const originValues = new Set(validRows.map((row) => row.TimezoneOrigin));
  let name: string | null = names.size === 1 ? [...names][0] : null;
  let origin = originValues.has("provider_metadata") ? "provider_metadata" : originValues.size === 1 && originValues.has("timestamp") ? "timestamp" : originValues.size === 1 && originValues.has("symbol_market_convention") ? "symbol_market_convention" : "unknown";
  if (!name || !validRows.some((row) => clocks.get(row))) { name = null; origin = "unknown"; }
  assert(quality.source_timezone === name && quality.timezone_origin === origin);
  const observedEpoch = Date.parse(quality.observed_at), utcDay = quality.observed_at.slice(0, 10);
  const states = validRows.map((row) => {
    const clock = clocks.get(row);
    if (!name || !["timestamp", "provider_metadata"].includes(String(row.TimezoneOrigin)) || !clock) return "unknown";
    return clock.provisional || clock.label >= utcDay || clock.label >= parts(clock.zone, observedEpoch).slice(0, 10) ? "provisional" : "complete_provider_daily_rows";
  });
  const complete = validRows.filter((_, index) => states[index] === "complete_provider_daily_rows");
  assert(counts.usable_complete === complete.length && counts.provisional === states.filter((state) => state === "provisional").length && counts.unknown_completion === states.filter((state) => state === "unknown").length);
  assert(counts.latest_usable_date === (complete.length ? String(complete.at(-1)!.SourceTimestamp).slice(0, 10) : null));
  const status = complete.length ? states.at(-1) : states.includes("provisional") ? "provisional" : states.includes("unknown") ? "unknown" : "empty";
  assert(quality.completion_status === status);
}

/** Verify saved rows offline; opaque payload strings remain untouched. */
export function validateMarketObservations(quality: MarketVerificationQuality, record: EvidenceRecord, evidence: EvidenceBundle) {
  let count = 0;
  for (const source of record.sources) {
    if (source.provider !== quality.provider || source.historical_availability === "withheld" || !source.data_sha256) continue;
    const artifact = evidence.artifacts[source.data_sha256]; assert(artifact.kind === "normalized_data");
    const rows = table(parsePayload(artifact.payload));
    if (rows) { proof(quality, source, rows); count++; }
  }
  assert(count > 0);
}
