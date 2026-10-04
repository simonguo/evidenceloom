import type { CollectionToken, SnapshotStorage, SqlMutationReceipt, StorageAuthority, StorageError, StorageReply, TaskHead, TaskMutationRequest } from "../types";

const MAX = BigInt("9223372036854775807");
const operations = new Set(["create", "recreate", "update", "delete", "import", "clear"]);
const errorCodes = new Set(["storage_invalid_request", "storage_conflict", "storage_owned", "storage_unavailable", "storage_unknown_outcome", "storage_partial_clear"]);
export const definitiveErrors = new Set(["storage_invalid_request", "storage_conflict", "storage_owned"]);
export function detached<T>(value: T): T {
  const captured = JSON.parse(JSON.stringify(value)) as T;
  function freeze(item: unknown) { if (item && typeof item === "object") { Object.values(item).forEach(freeze); Object.freeze(item); } }
  freeze(captured); return captured;
}
function invalid(): never { throw new Error("Desktop task storage acknowledgement could not be verified."); }
function object(value: unknown): Record<string, unknown> { if (!value || typeof value !== "object" || Array.isArray(value)) invalid(); return value as Record<string, unknown>; }
function exact(value: Record<string, unknown>, keys: string[]) { if (Object.keys(value).sort().join("|") !== keys.sort().join("|")) invalid(); }
function text(value: unknown): string { if (typeof value !== "string" || !value.length) invalid(); return value; }
export function counter(value: unknown): string { const result = text(value); if (result.length > 19 || !/^(0|[1-9][0-9]*)$/.test(result) || BigInt(result) > MAX) invalid(); return result; }
export function nextCounter(value: string): string { const n = BigInt(counter(value)); if (n === MAX) invalid(); return String(n + BigInt(1)); }
export function sameCollection(a: CollectionToken, b: CollectionToken) { return a.collectionId === b.collectionId && a.epoch === b.epoch; }
export function sameHead(a: TaskHead | undefined, b: TaskHead | undefined) { return !!a && !!b && a.taskId === b.taskId && a.generation === b.generation && a.revision === b.revision && a.state === b.state; }
function readCollection(value: unknown): CollectionToken { const o = object(value); exact(o, ["collectionId", "epoch"]); return { collectionId: text(o.collectionId), epoch: counter(o.epoch) }; }
function readHead(value: unknown, persisted: boolean): TaskHead {
  const o = object(value); exact(o, ["taskId", "generation", "revision", "state"]);
  if (o.state !== "live" && o.state !== "tombstone" && o.state !== "never_seen") invalid();
  const result: TaskHead = { taskId: text(o.taskId), generation: counter(o.generation), revision: counter(o.revision), state: o.state };
  if (result.state === "never_seen" ? persisted || result.generation !== "0" || result.revision !== "0" : result.generation === "0" || result.revision === "0") invalid();
  return result;
}
function readHeads(value: unknown, persisted = true): TaskHead[] {
  if (!Array.isArray(value)) invalid(); const rows = value.map((item) => readHead(item, persisted));
  if (new Set(rows.map((row) => row.taskId)).size !== rows.length) invalid(); return rows;
}
function readAuthority(value: unknown): StorageAuthority { const o = object(value); exact(o, ["collection", "heads"]); return { collection: readCollection(o.collection), heads: readHeads(o.heads) }; }
export function readSnapshotStorage(value: unknown): SnapshotStorage {
  const o = object(value); exact(o, ["collection", "heads", "legacyTaskImportAllowed"]);
  if (typeof o.legacyTaskImportAllowed !== "boolean") invalid();
  return detached({ ...readAuthority({ collection: o.collection, heads: o.heads }), legacyTaskImportAllowed: o.legacyTaskImportAllowed });
}
export function readStorageError(value: unknown): StorageError | null {
  if (!value || typeof value !== "object") return null; const o = value as Record<string, unknown>;
  if (typeof o.code !== "string" || !errorCodes.has(o.code) || typeof o.message !== "string") return null;
  return detached({ code: o.code, message: o.message });
}
function expectedResult(request: TaskMutationRequest): TaskHead[] {
  if (request.operation === "clear") return [];
  const source = request.operation === "import" ? request.expectedHeads : [request.expectedHead];
  return source.map((head) => ({ taskId: head.taskId,
    generation: request.operation === "create" || request.operation === "import" || head.state === "never_seen" ? "1" : request.operation === "recreate" ? nextCounter(head.generation) : head.generation,
    revision: request.operation === "create" || request.operation === "recreate" || request.operation === "import" || head.state === "never_seen" ? "1" : nextCounter(head.revision),
    state: request.operation === "delete" ? "tombstone" : "live" }));
}
function readReceipt(value: unknown, request: TaskMutationRequest): SqlMutationReceipt {
  const o = object(value); exact(o, ["protocolVersion", "requestId", "digest", "operation", "collection", "heads", "sqlCommitted"]);
  if (o.protocolVersion !== 1 || o.requestId !== request.requestId || o.operation !== request.operation || o.sqlCommitted !== true || typeof o.digest !== "string" || !/^[0-9a-f]{64}$/.test(o.digest)) invalid();
  const collection = readCollection(o.collection), heads = readHeads(o.heads);
  if (collection.collectionId !== request.collection.collectionId || collection.epoch !== (request.operation === "clear" ? nextCounter(request.collection.epoch) : request.collection.epoch)) invalid();
  const expected = expectedResult(request);
  if (expected.length !== heads.length || expected.some((row) => !sameHead(row, heads.find((item) => item.taskId === row.taskId)))) invalid();
  return { protocolVersion: 1, requestId: request.requestId, digest: o.digest, operation: request.operation, collection, heads, sqlCommitted: true };
}
export function readReply(value: unknown, request: TaskMutationRequest, query: boolean): StorageReply {
  const o = object(value); exact(o, ["scope", "receipt", "rejection", "current"]);
  if (o.scope !== "sql" && o.scope !== "desktop_clear") invalid();
  if (o.scope === "desktop_clear" && (query || request.operation !== "clear")) invalid();
  const receipt = o.receipt === null ? null : readReceipt(o.receipt, request);
  const rejection = o.rejection === null ? null : readStorageError(o.rejection);
  if (o.rejection !== null && !rejection || receipt && rejection || !query && !receipt || o.scope === "desktop_clear" && !receipt) invalid();
  const current = readAuthority(o.current);
  if (current.collection.collectionId !== request.collection.collectionId || BigInt(current.collection.epoch) < BigInt(request.collection.epoch)) invalid();
  return detached({ scope: o.scope, receipt, rejection, current });
}
export function validateRequest(request: TaskMutationRequest): TaskMutationRequest {
  const o = object(request); if (o.protocolVersion !== 1 || !operations.has(String(o.operation)) || typeof o.requestId !== "string" || !/^[A-Za-z0-9:_-]{1,128}$/.test(o.requestId)) invalid();
  readCollection(o.collection);
  const keys = ["protocolVersion", "requestId", "collection", "operation"];
  if (request.operation === "clear") exact(o, keys);
  else if (request.operation === "import") {
    exact(o, [...keys, "expectedHeads", "tasks"]); const heads = readHeads(request.expectedHeads, false);
    if (!Array.isArray(request.tasks) || heads.length !== request.tasks.length || heads.some((head) => head.state !== "never_seen") || new Set(request.tasks.map((task) => task.id)).size !== request.tasks.length || request.tasks.some((task) => !heads.some((head) => head.taskId === task.id))) invalid();
  } else {
    exact(o, [...keys, "expectedHead", ...(request.operation === "delete" ? [] : ["task"])]); const head = readHead(request.expectedHead, false);
    if (request.operation !== "delete" && (request.task.id !== head.taskId || request.operation === "create" && head.state !== "never_seen" || request.operation === "recreate" && head.state !== "tombstone" || request.operation === "update" && head.state !== "live")) invalid();
  }
  return detached(request);
}
