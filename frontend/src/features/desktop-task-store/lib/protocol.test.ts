import { describe, expect, it } from "vitest";
import { createEmptyTask, defaultTaskDraft } from "@/lib/analysis";
import { counter, nextCounter, readReply, readSnapshotStorage, validateRequest } from "./protocol";
import type { TaskMutationRequest } from "../types";
import corpus from "../../../../../tests/fixtures/desktop_task_store_wire_v1.json";
import type { AnalysisTask } from "@/lib/types";

const collection = { collectionId: "owned-collection", epoch: "1" };
const task = createEmptyTask(defaultTaskDraft(), "owned-task");
const request: TaskMutationRequest = { protocolVersion: 1, requestId: "owned-request", collection, operation: "create", expectedHead: { taskId: task.id, generation: "0", revision: "0", state: "never_seen" }, task };
const head = { taskId: task.id, generation: "1", revision: "1", state: "live" };
function reply() { return { scope: "sql", receipt: { protocolVersion: 1, requestId: request.requestId, digest: "a".repeat(64), operation: "create", collection, heads: [head], sqlCommitted: true }, rejection: null, current: { collection, heads: [head] } }; }

describe("strict owned frontend wire validation (not native canonical digest proof)", () => {
  it.each(["00", "01", "-1", "1.0", "1e2", "9223372036854775808", 1, null])("rejects noncanonical or out-of-range counter %s", (value) => expect(() => counter(value)).toThrow());
  it("accepts i64 maximum but rejects its increment", () => { expect(counter("9223372036854775807")).toBe("9223372036854775807"); expect(() => nextCounter("9223372036854775807")).toThrow(); });
  it("detaches and recursively freezes the original packet including unknown task fields", () => {
    const input = { ...request, task: { ...task, ownedExtra: { values: ["original"] } } };
    const frozen = validateRequest(input);
    input.task.ownedExtra.values[0] = "changed";
    expect(JSON.stringify(frozen)).toContain('"original"'); expect(Object.isFrozen(frozen)).toBe(true); expect(Object.isFrozen(frozen.operation === "create" && frozen.task.logs)).toBe(true);
  });
  it.each(["task", "digest", "unexpected"])("rejects irrelevant clear field %s", (field) => expect(() => validateRequest({ protocolVersion: 1, requestId: "clear", collection, operation: "clear", [field]: task } as TaskMutationRequest)).toThrow());
  it("requires a complete unique persisted-head snapshot", () => {
    expect(() => readSnapshotStorage({ collection, heads: [head, head], legacyTaskImportAllowed: false })).toThrow();
    expect(() => readSnapshotStorage({ collection, heads: [request.expectedHead], legacyTaskImportAllowed: false })).toThrow();
    expect(() => readSnapshotStorage({ collection, heads: [], legacyTaskImportAllowed: false, tasks: [] })).toThrow();
  });
  it.each(["requestId", "operation", "digest", "collection", "heads"])("rejects mismatched historical receipt field %s", (field) => {
    const value = reply(); Object.assign(value.receipt, { [field]: field === "collection" ? { ...collection, epoch: "2" } : field === "heads" ? [] : "wrong" });
    expect(() => readReply(value, request, false)).toThrow();
  });
  it("keeps query null uncertainty distinct from rejection and from a broad clear acknowledgement", () => {
    const value = { scope: "sql", receipt: null, rejection: null, current: { collection, heads: [] } };
    expect(readReply(value, request, true).receipt).toBeNull(); expect(() => readReply(value, request, false)).toThrow();
    expect(() => readReply({ ...reply(), scope: "desktop_clear" }, request, true)).toThrow();
    expect(() => readReply({ ...reply(), rejection: { code: "storage_conflict", message: "owned" } }, request, true)).toThrow();
  });
  it("rejects duplicate import IDs and task/head mismatch without altering tasks", () => {
    expect(() => validateRequest({ protocolVersion: 1, requestId: "import", collection, operation: "import", tasks: [task, task], expectedHeads: [request.expectedHead, request.expectedHead] })).toThrow();
    expect(() => validateRequest({ ...request, task: { ...task, id: "other" } })).toThrow();
  });
});

describe("exact production Rust serializer corpus from owned SQLite", () => {
  it("parses the actual consistent snapshot and matches all live task IDs", () => {
    expect(corpus.protocolVersion).toBe(1);
    const snapshot = JSON.parse(corpus.snapshotJson) as { tasks: AnalysisTask[]; storage: unknown };
    const storage = readSnapshotStorage(snapshot.storage);
    expect(storage.heads.filter((head) => head.state === "live").map((head) => head.taskId).sort()).toEqual(snapshot.tasks.map((task) => task.id).sort());
    expect(storage.heads.some((head) => head.state === "tombstone")).toBe(true);
  });
  it.each(corpus.cases)("accepts actual serialized $name through the production parser", (entry) => {
    const request = validateRequest(JSON.parse(entry.requestJson) as TaskMutationRequest);
    const response = readReply(JSON.parse(entry.responseJson), request, entry.kind === "query");
    if (entry.name === "query_unobserved") { expect(response.receipt).toBeNull(); expect(response.rejection).toBeNull(); }
    if (entry.name === "query_durable_rejection") { expect(response.receipt).toBeNull(); expect(response.rejection?.code).toBe("storage_conflict"); }
    if (entry.name === "clear_direct_ack") expect(response.scope).toBe("desktop_clear");
    if (entry.name === "clear_duplicate_sql") expect(response.scope).toBe("sql");
    if (entry.name === "query_historical_create_after_clear") expect(response.receipt?.collection.epoch).not.toBe(response.current.collection.epoch);
  });
});
