import { webcrypto } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { sha256 } from "@/features/evidence/lib/validation";
import type { EvidenceBundle } from "@/features/evidence/types";
import { numericFixture } from "../fixtures/fictional-numeric";
import type { NumericReview, ReportTextSnapshot } from "../types";
import { requestFromReview } from "./derive";
import { copyNumericHistory, verifyNumericHistory } from "./history";
import { createNumericReview, copyPreparedNumericReview } from "./validation";
import { prepareNumericInput } from "./prepared";
import { selectionSpan } from "./spans";
import { utf8Sha } from "./guards";
import { verifyNumericTasks } from "./tasks";
const owner = { taskId: "task-fictional", versionId: "version-fictional" };
async function signed<T extends object>(value: T, key: string): Promise<T> {
    return { ...value, [key]: await sha256(Object.fromEntries(Object.entries(value).filter(([name]) => name !== key))) };
}
async function chain(values: NumericReview[]) {
    const result: NumericReview[] = [];
    for (const value of values) {
        const review = structuredClone(value);
        review.review_id = crypto.randomUUID();
        review.reviewed_at = "2026-01-09T13:00:00.000000Z";
        review.previous_review_sha256 = result.at(-1)?.review_sha256 ?? null;
        result.push(await signed(review, "review_sha256"));
    }
    return result;
}
async function modifiedInput(change: (evidence: EvidenceBundle, snapshot: ReportTextSnapshot) => Promise<void> | void) {
    const task = numericFixture(false), evidence = task.evidenceBundle!, snapshot = task.reportTextSnapshot!;
    await change(evidence, snapshot);
    const savedEvidence = await signed(evidence, "bundle_sha256");
    snapshot.evidence_bundle_sha256 = savedEvidence.bundle_sha256;
    return { evidence: savedEvidence, snapshot: await signed(snapshot, "snapshot_sha256") };
}
function request(snapshot: ReportTextSnapshot, base = numericFixture().reportVersions[0].numericReviews![0]) {
    const value = requestFromReview(base);
    value.target.report_snapshot_sha256 = snapshot.snapshot_sha256;
    return value;
}
function delayDigests() {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    vi.stubGlobal("crypto", { randomUUID: () => webcrypto.randomUUID(), subtle: { digest: async (algorithm: AlgorithmIdentifier, bytes: BufferSource) => {
                await gate;
                return webcrypto.subtle.digest(algorithm, bytes);
            } } });
    return release;
}
beforeEach(() => vi.stubGlobal("crypto", webcrypto));
afterEach(() => vi.unstubAllGlobals());
describe("captured operation-local numerical history verification", () => {
    it("independently validates 1000 chained receipts and returns isolated result copies", async () => {
        const task = numericFixture(), base = task.reportVersions[0].numericReviews![0];
        const history = await chain(Array.from({ length: 1000 }, () => base));
        const verified = await verifyNumericHistory(history, task.reportTextSnapshot!, task.evidenceBundle!, owner);
        expect(verified).toEqual(history);
        verified[0].result.source_context.transformations.push("Caller change");
        verified[0].operand.raw_number_lexeme = "999";
        expect(verified[1].result.source_context.transformations).not.toContain("Caller change");
        expect(copyNumericHistory(history, task.reportTextSnapshot!, task.evidenceBundle!, owner)).toEqual(history);
        expect(() => copyNumericHistory([...history, history[0]], task.reportTextSnapshot!, task.evidenceBundle!, owner)).toThrow();
    });
    it("captures history, evidence, snapshot and owner before delayed hash work", async () => {
        const task = numericFixture(), values = task.reportVersions[0].numericReviews!, original = structuredClone(values), capturedOwner = { ...owner };
        const release = delayDigests();
        const pending = verifyNumericHistory(values, task.reportTextSnapshot!, task.evidenceBundle!, capturedOwner);
        values[0].result.rounded_decimal = "999";
        task.reportTextSnapshot!.report_sections.market_report = "Changed after capture";
        task.evidenceBundle!.records[0].sources[0].transformations.push("Changed after capture");
        capturedOwner.versionId = "changed-after-capture";
        release();
        expect(await pending).toEqual(original);
    });
    it("captures a new request and whole owner list before its first await", async () => {
        const task = numericFixture(false), draft = request(task.reportTextSnapshot!), original = structuredClone(draft), originalTask = structuredClone(task), release = delayDigests();
        const created = createNumericReview(task.reportTextSnapshot!, task.evidenceBundle!, draft);
        const verifiedTasks = verifyNumericTasks([task]);
        draft.review_id = crypto.randomUUID();
        draft.operand.selector.field = "TieOne";
        task.id = "changed-task";
        task.reportVersions[0].id = "changed-version";
        task.reportVersions[0].reportSections.market_report = "Changed after capture";
        release();
        const review = await created, saved = (await verifiedTasks)[0];
        expect(review.review_id).toBe(original.review_id);
        expect(review.operand.selector).toEqual(original.operand.selector);
        expect(saved.id).toBe(originalTask.id);
        expect(saved.reportVersions[0].id).toBe(originalTask.reportVersions[0].id);
        expect(saved.reportVersions[0].reportSections).toEqual(originalTask.reportVersions[0].reportSections);
    });
    it("keeps same-artifact source metadata, table paths and report sections separate", async () => {
        const input = await modifiedInput(async (evidence, snapshot) => {
            const source = evidence.records[0].sources[0], old = source.data_sha256!, table = JSON.parse(evidence.artifacts[old].payload);
            table.rows[0][table.columns.indexOf("Close")] = 999;
            const artifact = { kind: "normalized_data" as const, payload: evidence.artifacts[old].payload.slice(0, -1) + ',"latest_ohlcv":' + JSON.stringify(table) + "}" };
            const hash = await sha256(artifact);
            delete evidence.artifacts[old];
            evidence.artifacts[hash] = artifact;
            source.data_sha256 = hash;
            evidence.records[0].sources.push({ ...structuredClone(source), provider: "eastmoney", units: "USD", transformations: ["Second saved source"] }, { ...structuredClone(source), historical_availability: "withheld" });
            snapshot.report_sections.sentiment_report = "FICT 2026-01-08 Close 125.02 USD";
        });
        const drafts = [request(input.snapshot), request(input.snapshot), request(input.snapshot), request(input.snapshot), request(input.snapshot)];
        drafts[1].operand.source_index = 1;
        const market = input.snapshot.report_sections.market_report!;
        drafts[1].context_bindings.units = selectionSpan(market, market.indexOf("USD"), market.indexOf("USD") + 3);
        drafts[2].operand.source_index = 2;
        drafts[3].operand.selector.table_path = ["latest_ohlcv"];
        const social = input.snapshot.report_sections.sentiment_report!;
        drafts[4].target.section_key = "sentiment_report";
        drafts[4].target.section_utf8_sha256 = await utf8Sha(social);
        drafts[4].numeric_span = selectionSpan(social, social.indexOf("125.02"), social.indexOf("125.02") + 6);
        const history = await chain(await Promise.all(drafts.map((draft) => createNumericReview(input.snapshot, input.evidence, draft))));
        expect((await verifyNumericHistory(history, input.snapshot, input.evidence, owner)).map((item) => item.result.reason)).toEqual(["value_match", "value_match", "source_withheld", "value_mismatch", "value_match"]);
        expect(history[1].result.context_results.units).toBe("match");
        expect(history[1].result.source_context.provider).toBe("eastmoney");
        const badSection = structuredClone(history);
        badSection[4].target.section_utf8_sha256 = history[0].target.section_utf8_sha256;
        badSection[4] = await signed(badSection[4], "review_sha256");
        await expect(verifyNumericHistory(badSection, input.snapshot, input.evidence, owner)).rejects.toThrow("reference_mismatch");
        const forged = structuredClone(history);
        forged[3].result.status = "match";
        forged[3].result.reason = "value_match";
        forged[3] = await signed(forged[3], "review_sha256");
        expect(() => copyNumericHistory(forged, input.snapshot, input.evidence, owner)).toThrow("reference_mismatch");
    });
    it("rederives repeated field/date selections and never reuses an earlier operation's changed envelope", async () => {
        const task = numericFixture(), original = task.reportVersions[0].numericReviews![0], first = request(task.reportTextSnapshot!), field = request(task.reportTextSnapshot!), date = request(task.reportTextSnapshot!);
        field.operand.selector.field = "TieOne";
        date.operand.selector.row_date = "2026-01-07";
        const history = await chain(await Promise.all([first, field, date, first].map((draft) => createNumericReview(task.reportTextSnapshot!, task.evidenceBundle!, draft))));
        expect((await verifyNumericHistory(history, task.reportTextSnapshot!, task.evidenceBundle!, owner)).map((item) => item.result.reason)).toEqual(["value_match", "value_mismatch", "value_mismatch", "value_match"]);
        const forged = structuredClone(history);
        forged[3].result.rounded_decimal = "999";
        forged[3] = await signed(forged[3], "review_sha256");
        await expect(verifyNumericHistory(forged, task.reportTextSnapshot!, task.evidenceBundle!, owner)).rejects.toThrow("reference_mismatch");
        const changed = await modifiedInput(async (evidence) => {
            const source = evidence.records[0].sources[0], old = source.data_sha256!, payload = evidence.artifacts[old].payload.replace("125.02345678901236", "999.02345678901236"), artifact = { kind: "normalized_data" as const, payload }, hash = await sha256(artifact);
            delete evidence.artifacts[old];
            evidence.artifacts[hash] = artifact;
            source.data_sha256 = hash;
        });
        const newReview = await createNumericReview(changed.snapshot, changed.evidence, request(changed.snapshot));
        expect(newReview.result.reason).toBe("value_mismatch");
        await expect(verifyNumericHistory([newReview], changed.snapshot, changed.evidence, owner)).resolves.toEqual([newReview]);
        await expect(verifyNumericHistory([original], task.reportTextSnapshot!, task.evidenceBundle!, owner)).resolves.toEqual([original]);
        await expect(verifyNumericHistory([original], changed.snapshot, changed.evidence, owner)).rejects.toThrow("reference_mismatch");
    });
    it.each(["hash", "owner", "chain", "chronology", "uuid"])("rejects a non-head coherent %s defect", async (kind) => {
        const task = numericFixture(), history = await chain(Array.from({ length: 20 }, () => task.reportVersions[0].numericReviews![0])), last = history.at(-1)!;
        if (kind === "hash")
            last.review_sha256 = "f".repeat(64);
        else {
            if (kind === "owner")
                last.target.version_id = "other-version";
            if (kind === "chain")
                last.previous_review_sha256 = "0".repeat(64);
            if (kind === "chronology")
                last.reviewed_at = "2026-01-09T12:59:00.000000Z";
            if (kind === "uuid")
                last.review_id = history[0].review_id;
            history[history.length - 1] = await signed(last, "review_sha256");
        }
        await expect(verifyNumericHistory(history, task.reportTextSnapshot!, task.evidenceBundle!, owner)).rejects.toThrow(kind === "hash" ? "hash_mismatch" : "reference_mismatch");
    });
    it("rejects stale envelope hashes, duplicate raw keys and fabricated prepared trust", async () => {
        const task = numericFixture(), review = task.reportVersions[0].numericReviews![0], stale = structuredClone(task.evidenceBundle!);
        stale.manifest.core_version = "Changed without rehashing";
        await expect(verifyNumericHistory([review], task.reportTextSnapshot!, stale, owner)).rejects.toThrow("hash_mismatch");
        const input = await modifiedInput(async (evidence) => {
            const source = evidence.records[0].sources[0], old = source.data_sha256!, artifact = { kind: "normalized_data" as const, payload: '{"columns":["Date","Close"],"rows":[["2026-01-08",125.02]],"rows":[["2026-01-08",999]]}' }, hash = await sha256(artifact);
            delete evidence.artifacts[old];
            evidence.artifacts[hash] = artifact;
            source.data_sha256 = hash;
        });
        await expect(createNumericReview(input.snapshot, input.evidence, request(input.snapshot))).rejects.toThrow();
        const prepared = prepareNumericInput(task.reportTextSnapshot!, task.evidenceBundle!);
        expect(() => copyPreparedNumericReview(review, { ...prepared }, owner)).toThrow("reference_mismatch");
        expect(() => { Object.assign(prepared, { verify: async () => { } }); }).toThrow();
    });
});
