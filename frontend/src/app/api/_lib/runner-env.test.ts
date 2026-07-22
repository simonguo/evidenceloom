import { describe, expect, it } from "vitest";
import {
  collectSensitiveValues,
  createRedactedLineBuffer,
  redactSensitiveText,
} from "./runner-env";

describe("runner output redaction", () => {
  it("collects session and inherited process credentials", () => {
    const values = collectSensitiveValues(
      { apiKey: "provider-secret", alphaVantageApiKey: "alpha-secret" },
      { NODE_ENV: "test", CI_TOKEN: "pipeline-secret", PUBLIC_VALUE: "safe" },
    );

    expect(values).toContain("provider-secret");
    expect(values).toContain("alpha-secret");
    expect(values).toContain("pipeline-secret");
    expect(values).not.toContain("safe");
  });

  it("redacts secrets from plain text and JSON", () => {
    const output = redactSensitiveText(
      '{"error":"provider-secret was rejected"}',
      ["provider-secret"],
    );

    expect(output).not.toContain("provider-secret");
    expect(output).toContain("[REDACTED]");
  });

  it("redacts a secret split across process output chunks", () => {
    const lines: string[] = [];
    const buffer = createRedactedLineBuffer(["provider-secret"], (line) => lines.push(line));
    buffer.push("first provider-");
    buffer.push("secret line\nsecond line");
    buffer.flush();

    expect(lines).toEqual(["first [REDACTED] line", "second line"]);
  });
});
