import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { captured, envelope, header, stamp } from "../test-support/fixtures";
import { freezePacket, readEnvelope, readEvent, readOutcome, readPage, RecoveryProtocolError } from "./protocol";
import { transportFixture } from "../test-support/transport-fixture";
import type { AdmissionRequest, ReadReply, ReadRequest } from "../types";
type Mutable<T> = { -readonly [P in keyof T]: T[P] extends object ? Mutable<T[P]> : T[P] };

describe("desktop recovery parsed-object boundary", () => {
  it("preserves literal timestamp, JSON whitespace, nullable section values and empty settings", () => {
    const h = header(), row = envelope(h, 2, "analysis", { event: { type: "completed", timestamp: "", reportSections: { market_report: "  owned\r\n报告  ", news_report: null } } });
    expect(readEnvelope(row)).toEqual(row); expect(freezePacket(captured().packet.request).request.context.requestedSettings.temperature).toBe("");
  });
  it("binds the committed display literal to explicit time, absence or unavailable marker", () => {
    const h = header(), missing = envelope(h, 2, "analysis", { event: { type: "progress" } });
    expect(readEnvelope(missing).seed.logTimestamp).toBe(stamp);
    expect(() => readEnvelope({ ...missing, seed: { ...missing.seed, logTimestamp: "local replay time" } })).toThrow(RecoveryProtocolError);
    const unsafe = envelope(h, 3, "publication_unavailable", { sourceType: "progress", channels: [{ channel: "timestamp", reason: "unsafe_content" }], outcome: "optional_unavailable", code: "analysis_publication_unavailable", safeAnalysis: { type: "progress" } });
    expect(readEnvelope(unsafe).seed.logTimestamp).toBe("[unavailable]");
    expect(() => readEnvelope({ ...unsafe, seed: { ...unsafe.seed, logTimestamp: stamp } })).toThrow();
  });
  it("rejects critical channels falsely classified optional and top-level null reports", () => {
    const row = envelope(header(), 2, "publication_unavailable", { sourceType: "completed", channels: [{ channel: "reportSections", reason: "unsafe_content" }], outcome: "analysis_failed", code: "analysis_publication_unavailable", safeAnalysis: { type: "completed" } });
    expect(readEnvelope(row)).toEqual(row);
    expect(() => readEnvelope({ ...row, payload: { ...row.payload, outcome: "optional_unavailable" } })).toThrow();
    expect(() => readEvent({ type: "completed", reportSections: null })).toThrow();
    expect(() => readEvent({ type: "error", error: "raw backend detail" })).toThrow();
  });
  it("counts UTF-8 and JSON escaping at the exact 64KiB original admission boundary", () => {
    const original = JSON.parse(captured().packet.requestJson) as Mutable<AdmissionRequest>;
    const fields = [original.context.requestedSettings, original.context.originalRunContext.manifest] as unknown as Record<string, unknown>[];
    let remaining = 65536 - new TextEncoder().encode(JSON.stringify(original)).length;
    for (const object of fields) for (const key of Object.keys(object)) {
      if (typeof object[key] !== "string" || key === "systemLanguage") continue;
      const add = Math.min(remaining, 4096 - String(object[key]).length); object[key] = String(object[key]) + "x".repeat(add); remaining -= add;
    }
    expect(remaining).toBe(0); expect(new TextEncoder().encode(freezePacket(original).requestJson).length).toBe(65536);
    original.context.input.ticker += "x";
    expect(() => freezePacket(original)).toThrow();
    const escaped = JSON.parse(captured().packet.requestJson) as Mutable<AdmissionRequest>;
    escaped.context.requestedSettings.benchmarkTicker = "\"".repeat(4096);
    expect(new TextEncoder().encode(freezePacket(escaped).requestJson).length).toBeGreaterThan(8000);
    escaped.context.requestedSettings.benchmarkTicker = "界".repeat(1366);
    expect(() => freezePacket(escaped)).toThrow();
  });
  it("rejects counter, paging, mode and duplicate-analyst drift before invoke", () => {
    const h = header();
    expect(() => freezePacket({ recoveryProtocolVersion: 1, journalId: h.journalId, origin: h.origin, binding: h.binding, afterSeq: "02", throughSeq: null, limit: 1 })).toThrow();
    expect(() => freezePacket({ recoveryProtocolVersion: 1, journalId: h.journalId, origin: h.origin, binding: h.binding, afterSeq: "2", throughSeq: "1", limit: 1 })).toThrow();
    const packet = JSON.parse(captured().packet.requestJson) as AdmissionRequest; packet.context.input.analysts.push("market");
    expect(() => freezePacket(packet)).toThrow();
  });
  it("accepts a directly returned durable rejection and refuses a direct unknown outcome", async () => {
    const f = transportFixture({ rejectedAdmission: true }), reply = await f.api.invoke("query_analysis_reservation", { requestJson: f.captured.packet.requestJson }) as Record<string, unknown>;
    expect(readOutcome(reply, "analysis_admission", f.captured.packet.request).rejection?.code).toBe("analysis_conflict");
    expect(() => readOutcome({ ...reply, rejection: null }, "analysis_admission", f.captured.packet.request)).toThrow();
    expect(readOutcome({ ...reply, rejection: null }, "analysis_admission", f.captured.packet.request, true).receipt).toBeNull();
  });
});

const actualCorpus = process.env.EVIDENCELOOM_RECOVERY_CORPUS_INPUT;
it.skipIf(!actualCorpus)("parses actual native SQL serializer pages including Float-to-JS numeric forms", () => {
  const raw = readFileSync(actualCorpus!, "utf8"), corpus = JSON.parse(raw) as { producer: string; readReplies: ReadReply[] };
  expect(corpus.producer).toBe("actual-native-sql-read-v1"); expect(corpus.readReplies).toHaveLength(8);
  for (const page of corpus.readReplies) {
    const request: ReadRequest = { recoveryProtocolVersion: 1, journalId: page.header.journalId, origin: page.header.origin, binding: page.header.binding, afterSeq: page.afterSeq, throughSeq: page.throughSeq, limit: 64 };
    const parsed = readPage(page, request); expect(parsed.rows.map((row) => row.payloadDigest)).toEqual(page.rows.map((row) => row.payloadDigest)); expect(parsed.rangeProof).toEqual(page.rangeProof);
    // JSON numeric lexical form is transport representation; native original hashes stay unchanged.
    expect(JSON.stringify(parsed)).toBe(JSON.stringify(page));
  }
  expect(raw).toMatch(/"elapsedSeconds"\s*:\s*1\.0/); expect(raw).toMatch(/"elapsedSeconds"\s*:\s*0\.0/); expect(raw).toMatch(/"elapsedSeconds"\s*:\s*-0\.0/);
});
