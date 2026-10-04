import type { AnalysisTask, ReportVersion } from "@/lib/types";
import type { CollectionToken, MutationOutcome, MutationTransport, ReviewAction, RunOwner, StorageAuthority, StorageError, TaskAction, TaskHead, TaskMutationRequest, TaskStoreState } from "../types";
import { detached, definitiveErrors, readReply, readSnapshotStorage, readStorageError, sameCollection, sameHead, validateRequest } from "./protocol";

type Owner = { id: string; collection: CollectionToken; birth: object; alive: boolean; deleting: boolean; blocked: boolean; tail: Node; published: number; runs: Set<Run> };
type Node = { owner?: Owner; collection: CollectionToken; serial: number; parent?: Node; head?: TaskHead;
  operation: TaskMutationRequest["operation"] | "snapshot"; requestId: string; projection: Promise<AnalysisTask>;
  cancelled: boolean; sent: boolean; request?: TaskMutationRequest; promise?: Promise<MutationOutcome>; outcome?: MutationOutcome;
  importTasks?: AnalysisTask[]; expectedHeads?: TaskHead[] };
type Run = { owner: Owner; tail: Node; active: boolean };
const unavailable: StorageError = { code: "storage_unknown_outcome", message: "Task storage could not be confirmed. Retry confirmation before continuing." };
const conflict: StorageError = { code: "storage_conflict", message: "This task changed after the action began. Reload its confirmed state before trying again." };
const rejected = (error: StorageError): MutationOutcome => ({ kind: "rejected", error });
const unknown = (error: StorageError = unavailable): MutationOutcome => ({ kind: "unknown", error });
class CancelledIntent extends Error {}
class RejectedPredecessor extends Error { constructor(readonly error: StorageError) { super(error.message); } }

/** Native SQL authority for one live frontend lifetime; never a refresh recovery store. */
export class DesktopTaskMutations {
  private authority?: StorageAuthority;
  private importAllowed = false;
  private active = true;
  private sealed = false;
  private clearing = false;
  private sequence = 0;
  private owners = new Map<string, Owner>();
  private bindings = new WeakMap<object, Node>();
  private actions = new WeakMap<object, Node>();
  private reviewVersions = new WeakMap<object, ReportVersion>();
  private runs = new WeakMap<object, Run>();
  private pending = new Set<Node>();
  private clearNode?: Node;
  state: TaskStoreState = "unavailable";

  constructor(private transport: MutationTransport, private changed: (state: TaskStoreState) => void = () => {}) {}
  private setState(state: TaskStoreState) { this.state = state; if (this.active) this.changed(state); }
  get initialized() { return this.active && !!this.authority; }
  get ready() { return this.initialized && this.sealed && !this.clearing && ![...this.pending].some((node) => node.outcome?.kind === "unknown") && ![...this.owners.values()].some((owner) => owner.blocked); }
  initialize(storage: unknown, tasks: readonly AnalysisTask[]) {
    if (!this.active || this.clearing || [...this.pending].some((node) => !node.outcome || node.outcome.kind === "unknown")) throw new Error(unavailable.message);
    const authority = readSnapshotStorage(storage), ids = new Set(tasks.map((task) => task.id));
    if (ids.size !== tasks.length || authority.heads.some((head) => head.state === "live" && !ids.has(head.taskId)) || tasks.some((task) => !authority.heads.some((head) => head.taskId === task.id && head.state === "live"))) throw new Error(unavailable.message);
    this.owners.forEach((owner) => { owner.alive = false; }); this.owners.clear(); this.pending.clear();
    this.authority = authority; this.importAllowed = authority.legacyTaskImportAllowed; this.sealed = false; this.clearing = false;
    tasks.forEach((task) => {
      const node = this.node("snapshot", authority.collection, Promise.resolve(detached(task)));
      node.head = authority.heads.find((head) => head.taskId === task.id)!;
      const owner: Owner = { id: task.id, collection: authority.collection, birth: {}, alive: true, deleting: false, blocked: false, tail: node, published: node.serial, runs: new Set() };
      node.owner = owner; this.owners.set(task.id, owner); this.bindings.set(task, node);
    });
    this.setState("unavailable");
  }
  seal() { if (!this.initialized) throw new Error(unavailable.message); this.sealed = true; this.refreshState(); }
  dispose() { this.active = false; this.owners.forEach((owner) => { owner.alive = false; }); }
  private node(operation: Node["operation"], collection: CollectionToken, projection: Promise<AnalysisTask>): Node {
    const result: Node = { operation, collection: detached(collection), serial: ++this.sequence, requestId: crypto.randomUUID(), projection, cancelled: false, sent: false };
    void projection.catch(() => undefined); return result;
  }
  private action(node: Node): TaskAction { const action = Object.freeze({ token: {} }); this.actions.set(action.token, node); return action; }
  private resolve(action: TaskAction): Node { const node = action && this.actions.get(action.token); if (!node || !this.valid(node)) throw new Error(conflict.message); return node; }
  private valid(node: Node) { return this.active && !!this.authority && sameCollection(node.collection, this.authority.collection) && !node.cancelled && (!node.owner || node.owner.alive && this.owners.get(node.owner.id) === node.owner); }
  private refreshState() {
    if (!this.initialized || !this.sealed) this.setState("unavailable");
    else if (this.clearing || [...this.pending].some((node) => node.outcome?.kind === "unknown")) this.setState("unknown");
    else if ([...this.owners.values()].some((owner) => owner.blocked)) this.setState("conflict");
    else this.setState(this.pending.size ? "pending" : "ready");
  }
  capture(task: AnalysisTask): TaskAction { const node = this.bindings.get(task); if (!node || !this.valid(node) || node.owner?.deleting) throw new Error(conflict.message); return this.action(node); }
  identity(task: AnalysisTask) { const node = this.bindings.get(task); return node && this.valid(node) ? node.owner?.birth : undefined; }
  captureId(id: string): TaskAction { const owner = this.owners.get(id); if (!owner || owner.deleting || !owner.alive) throw new Error(conflict.message); return this.action(owner.tail); }
  captureReview(task: AnalysisTask, versionId: string): ReviewAction {
    const action = this.capture(task), version = task.reportVersions.find((item) => item.id === versionId);
    if (!version) throw new Error(conflict.message); const frozen = detached(version); this.reviewVersions.set(action.token, frozen); return Object.freeze({ ...action, versionId, version: frozen });
  }
  reviewVersion(value: unknown): ReportVersion { const action = value as ReviewAction; this.resolve(action); const version = this.reviewVersions.get(action.token); if (!version) throw new Error(conflict.message); return detached(version); }
  async projection(action: TaskAction): Promise<AnalysisTask> { return this.resolve(action).projection; }
  bind(task: AnalysisTask, action: TaskAction) { const node = this.resolve(action); this.bindings.set(task, node); }
  mayProject(action: TaskAction) {
    const node = this.resolve(action), owner = node.owner;
    return !!owner && !owner.deleting && this.inTail(node) && node.serial >= owner.published;
  }
  private inTail(node: Node) { for (let item = node.owner?.tail; item; item = item.parent) if (item === node) return true; return false; }
  markProjected(task: AnalysisTask, action: TaskAction) { const node = this.resolve(action); if (!this.mayProject(action)) return false; node.owner!.published = node.serial; this.bindings.set(task, node); return true; }
  prepareCreate(task: AnalysisTask): TaskAction {
    if (!this.ready || this.owners.has(task.id)) throw new Error(unavailable.message);
    const authority = this.authority!, observed = authority.heads.find((head) => head.taskId === task.id);
    if (observed?.state === "live") throw new Error(conflict.message);
    const node = this.node(observed ? "recreate" : "create", authority.collection, Promise.resolve(detached(task)));
    node.head = observed ?? { taskId: task.id, generation: "0", revision: "0", state: "never_seen" };
    const owner: Owner = { id: task.id, collection: node.collection, birth: {}, alive: true, deleting: false, blocked: false, tail: node, published: node.serial, runs: new Set() };
    node.owner = owner; this.owners.set(task.id, owner); this.bindings.set(task, node); return this.action(node);
  }
  prepareUpdate(action: TaskAction, transform: (original: AnalysisTask) => AnalysisTask | Promise<AnalysisTask>): TaskAction {
    const parent = this.resolve(action), owner = parent.owner;
    if (!owner || owner.deleting || owner.blocked || this.clearing || owner.tail !== parent) throw new Error(conflict.message);
    const projection = parent.projection.then((original) => transform(detached(original))).then(detached);
    const node = this.node("update", parent.collection, projection); node.parent = parent; node.owner = owner;
    if (owner.tail === parent) owner.tail = node;
    owner.runs.forEach((run) => { if (run.active && run.tail === parent) run.tail = node; });
    return this.action(node);
  }
  captureRun(action: TaskAction): RunOwner {
    const node = this.resolve(action); if (!this.ready || !node.owner || node.owner.tail !== node || node.owner.deleting || node.owner.blocked) throw new Error(conflict.message);
    const handle = Object.freeze({ token: {} }), run = { owner: node.owner, tail: node, active: true };
    node.owner.runs.add(run); this.runs.set(handle.token, run); return handle;
  }
  retireRun(handle: RunOwner) { const run = this.runs.get(handle.token); if (run) { run.active = false; run.owner.runs.delete(run); } }
  prepareRunUpdate(handle: RunOwner, transform: (original: AnalysisTask) => AnalysisTask | Promise<AnalysisTask>): TaskAction {
    const run = this.runs.get(handle.token);
    if (!run?.active || !run.owner.alive || run.owner.deleting || this.owners.get(run.owner.id) !== run.owner || !this.valid(run.tail)) throw new Error(conflict.message);
    const action = this.prepareUpdate(this.action(run.tail), transform); run.tail = this.resolve(action); return action;
  }
  prepareDelete(task: AnalysisTask | string): TaskAction {
    if (!this.initialized || !this.sealed || this.clearing) throw new Error(unavailable.message);
    const owner = this.owners.get(typeof task === "string" ? task : task.id);
    if (!owner || !owner.alive) throw new Error(conflict.message);
    if (typeof task !== "string" && this.identity(task) !== owner.birth) throw new Error(conflict.message);
    if (owner.deleting && owner.tail.operation === "delete") return this.action(owner.tail);
    const selected = typeof task === "string" ? owner.tail : this.resolve(this.capture(task));
    let parent: Node | undefined = selected;
    let create: Node | undefined = selected;
    while (create?.parent) create = create.parent;
    let head: TaskHead | undefined;
    if (create && (create.operation === "create" || create.operation === "recreate") && !create.sent) {
      for (let item: Node | undefined = selected; item; item = item.parent) if (item.operation !== "snapshot") item.cancelled = true;
      head = create.head; parent = undefined;
    }
    const node = this.node("delete", selected.collection, selected.projection); node.owner = owner; node.parent = parent; node.head = head;
    owner.deleting = true; owner.tail = node; return this.action(node);
  }
  prepareClear(): TaskAction {
    if (!this.initialized || !this.sealed) throw new Error(unavailable.message);
    if (this.clearNode && this.clearing) return this.action(this.clearNode);
    const node = this.node("clear", this.authority!.collection, Promise.resolve({} as AnalysisTask));
    this.clearing = true;
    this.pending.forEach((item) => { if (!item.sent) item.cancelled = true; });
    this.clearNode = node; return this.action(node);
  }
  prepareImport(tasks: readonly AnalysisTask[]): TaskAction {
    if (!this.initialized || !this.importAllowed || this.authority!.heads.length || this.sealed) throw new Error(conflict.message);
    const node = this.node("import", this.authority!.collection, Promise.resolve({} as AnalysisTask));
    node.importTasks = detached([...tasks]); node.expectedHeads = tasks.map((task) => ({ taskId: task.id, generation: "0", revision: "0", state: "never_seen" }));
    return this.action(node);
  }
  private async realize(node: Node) {
    if (node.request) return node.request;
    let head = node.head;
    if (node.parent) {
      if (node.parent.operation === "snapshot") head = node.parent.head;
      else {
        const result = await this.commitNode(node.parent);
        if (result.kind === "rejected") throw new RejectedPredecessor(result.error);
        if (result.kind !== "committed" || !result.publishable || !result.reply.receipt) throw new Error(unavailable.message);
        head = result.reply.receipt.heads.find((row) => row.taskId === node.owner?.id);
      }
      if (!head) throw new Error(conflict.message);
    }
    if (!this.valid(node)) throw new CancelledIntent(conflict.message);
    const common = { protocolVersion: 1 as const, requestId: node.requestId, collection: node.collection };
    const request: TaskMutationRequest = node.operation === "clear" ? { ...common, operation: "clear" }
      : node.operation === "import" ? { ...common, operation: "import", tasks: node.importTasks!, expectedHeads: node.expectedHeads! }
        : node.operation === "delete" ? { ...common, operation: "delete", expectedHead: head! }
          : { ...common, operation: node.operation as "create" | "recreate" | "update", expectedHead: head!, task: await node.projection };
    node.request = validateRequest(request); return node.request;
  }
  private observe(authority: StorageAuthority) {
    if (!this.authority || authority.collection.collectionId !== this.authority.collection.collectionId || BigInt(authority.collection.epoch) < BigInt(this.authority.collection.epoch)) return false;
    if (sameCollection(authority.collection, this.authority.collection)) {
      const heads = new Map(this.authority.heads.map((head) => [head.taskId, head]));
      for (const incoming of authority.heads) {
        const known = heads.get(incoming.taskId);
        if (known && incoming.generation === known.generation && incoming.revision === known.revision && incoming.state !== known.state) throw new Error(conflict.message);
        if (!known || BigInt(incoming.generation) > BigInt(known.generation) || incoming.generation === known.generation && BigInt(incoming.revision) > BigInt(known.revision)) heads.set(incoming.taskId, incoming);
      }
      this.authority = { collection: authority.collection, heads: [...heads.values()] }; return true;
    }
    if (!sameCollection(authority.collection, this.authority.collection)) {
      this.owners.forEach((owner) => { owner.alive = false; });
      this.pending.forEach((node) => { if (node.operation !== "clear" && !sameCollection(node.collection, authority.collection)) { if (!node.sent) node.cancelled = true; this.pending.delete(node); } });
    }
    this.authority = authority; return true;
  }
  private async receive(node: Node, value: unknown, query: boolean): Promise<MutationOutcome> {
    const request = node.request!, reply = readReply(value, request, query);
    const wasValid = this.valid(node) || node.operation === "clear" && this.active && this.clearNode === node && this.clearing && node.collection.collectionId === this.authority?.collection.collectionId; this.observe(reply.current);
    if (node.outcome?.kind === "rejected") return node.outcome;
    if (node.outcome?.kind === "committed" && !reply.receipt) {
      const prior = node.outcome, receipt = prior.reply.receipt!;
      const publishable = wasValid && sameCollection(receipt.collection, this.authority!.collection) && receipt.heads.every((head) => sameHead(head, this.authority!.heads.find((row) => row.taskId === head.taskId))) && (node.operation !== "clear" || prior.reply.scope === "desktop_clear" && this.authority!.heads.length === 0);
      return { ...prior, publishable };
    }
    if (reply.rejection) return rejected(reply.rejection);
    if (!reply.receipt) return unknown();
    if (node.outcome?.kind === "committed" && node.outcome.reply.receipt?.digest !== reply.receipt.digest) return { ...node.outcome, publishable: false };
    if (node.outcome?.kind === "committed" && node.outcome.reply.scope === "desktop_clear") return { ...node.outcome, publishable: false };
    const sameCurrent = sameCollection(this.authority!.collection, reply.receipt.collection);
    const matchingHeads = reply.receipt.heads.every((head) => sameHead(head, this.authority!.heads.find((row) => row.taskId === head.taskId)));
    const publishable = wasValid && sameCurrent && matchingHeads && (request.operation !== "clear" || reply.scope === "desktop_clear" && this.authority!.heads.length === 0);
    return { kind: "committed", reply, publishable };
  }
  private finish(node: Node, outcome: MutationOutcome) {
    node.outcome = outcome;
    if (outcome.kind === "unknown" || outcome.kind === "committed" && !outcome.publishable) {
      if (node.owner) node.owner.blocked = true;
    } else {
      this.pending.delete(node);
      if (node.owner && outcome.kind === "rejected") { node.owner.deleting = false; node.owner.blocked = outcome.error.code !== "storage_owned"; if (node.owner.tail === node && node.parent) node.owner.tail = node.parent; }
      if (outcome.kind === "committed" && outcome.publishable && node.owner) node.owner.blocked = false;
      if (outcome.kind === "committed" && node.operation === "delete" && outcome.publishable && node.owner && this.owners.get(node.owner.id) === node.owner) { node.owner.alive = false; this.owners.delete(node.owner.id); }
      if (node.operation === "clear" && this.clearNode === node && outcome.kind === "committed" && outcome.publishable) { this.clearing = false; this.owners.clear(); }
      if (node.operation === "clear" && this.clearNode === node && outcome.kind === "rejected") {
        this.clearing = !definitiveErrors.has(outcome.error.code);
        if (!this.clearing) this.clearNode = undefined;
      }
    }
    this.refreshState(); return outcome;
  }
  private commitNode(node: Node): Promise<MutationOutcome> {
    if (node.operation === "snapshot") return Promise.resolve(unknown());
    if (node.outcome) return Promise.resolve(node.outcome);
    if (node.promise) return node.promise;
    this.pending.add(node); this.refreshState();
    node.promise = (async () => {
      try {
        const request = await this.realize(node);
        const response = await this.transport.execute(request, () => { if (!this.valid(node) || node.operation !== "clear" && this.clearing) throw new CancelledIntent(conflict.message); node.sent = true; });
        return this.finish(node, await this.receive(node, response, false));
      } catch (error) {
        if (error instanceof CancelledIntent) return this.finish(node, rejected(conflict));
        if (error instanceof RejectedPredecessor) return this.finish(node, rejected(error.error));
        const typed = readStorageError(error);
        if (typed && definitiveErrors.has(typed.code)) return this.finish(node, rejected(typed));
        if (!node.request || !node.sent) return this.finish(node, unknown(typed ?? unavailable));
        try { return this.finish(node, await this.receive(node, await this.transport.query(node.request), true)); }
        catch { return this.finish(node, unknown(typed ?? unavailable)); }
      }
    })();
    return node.promise;
  }
  commit(action: TaskAction): Promise<MutationOutcome> { return this.commitNode(this.resolve(action)); }
  async retry(action: TaskAction): Promise<MutationOutcome> {
    const node = this.actions.get(action.token);
    if (!node || !this.active) return unknown();
    if (!node.request) {
      if (!node.sent && node.parent?.outcome?.kind === "committed" && node.parent.outcome.publishable) {
        node.outcome = undefined; node.promise = undefined; return this.commitNode(node);
      }
      return node.outcome ?? unknown();
    }
    try { return this.finish(node, await this.receive(node, await this.transport.query(node.request), true)); }
    catch { return node.outcome?.kind === "rejected" ? node.outcome : node.outcome?.kind === "committed" ? this.finish(node, { ...node.outcome, publishable: false }) : this.finish(node, unknown()); }
  }
  intent(action: TaskAction) { const node = this.actions.get(action.token); if (!node || !this.active) throw new Error(conflict.message); return { operation: node.operation, taskId: node.owner?.id }; }
  needsConfirmation(action: TaskAction) {
    const node = this.actions.get(action.token);
    return !!node && this.active && (node === this.clearNode && this.clearing || this.valid(node) && (node.outcome?.kind === "unknown" || node.outcome?.kind === "committed" && !node.outcome.publishable));
  }
  relevant(action: TaskAction) { const node = this.actions.get(action.token); return !!node && this.active && (this.valid(node) || node === this.clearNode && this.clearing); }
  async confirm(action: TaskAction) {
    const node = this.actions.get(action.token);
    if (!node || !this.active) return unknown();
    return node.outcome ? this.retry(action) : this.commit(action);
  }
  async awaitAdmission(action: TaskAction) {
    const node = this.resolve(action); const result = node.operation === "snapshot" ? undefined : await this.commitNode(node);
    return this.ready && this.valid(node) && node.owner?.tail === node && !node.owner.deleting && !node.owner.blocked && (!result || result.kind === "committed" && result.publishable);
  }
  publishable(action: TaskAction, outcome: MutationOutcome) {
    const node = this.actions.get(action.token);
    if (!node || !this.active || outcome.kind !== "committed" || !outcome.publishable) return false;
    if (node.operation === "delete") return !this.owners.has(node.owner!.id) && sameCollection(node.collection, this.authority!.collection);
    if (node.operation === "clear") return outcome.reply.scope === "desktop_clear" && !this.clearing && sameCollection(outcome.reply.receipt!.collection, this.authority!.collection) && this.authority!.heads.length === 0;
    return this.valid(node) && !node.owner?.deleting && this.inTail(node);
  }
}
