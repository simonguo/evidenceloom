export function errorMessage(error: unknown, fallback: string) {
  if (error instanceof Error && error.message) return readableErrorText(error.message, fallback);
  if (typeof error === "string" && error.trim()) return readableErrorText(error, fallback);
  if (typeof error === "object" && error !== null) {
    const record = error as Record<string, unknown>;
    const direct = record.error ?? record.message;
    if (typeof direct === "string" && direct.trim()) return readableErrorText(direct, fallback);
    try {
      const serialized = JSON.stringify(error);
      if (serialized && serialized !== "{}") return readableErrorText(serialized, fallback);
    } catch {
      return fallback;
    }
  }
  return fallback;
}

function readableErrorText(value: string, fallback: string) {
  const trimmed = value.trim();
  if (!trimmed) return fallback;
  try {
    const parsed = JSON.parse(trimmed) as unknown;
    if (parsed && typeof parsed === "object") {
      const record = parsed as Record<string, unknown>;
      const direct = record.error ?? record.message;
      if (typeof direct === "string" && direct.trim()) return direct.trim();
    }
  } catch {
    // Not JSON; use the original text below.
  }
  return trimmed;
}
