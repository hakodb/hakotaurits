// ponytail: Firestore-shaped HakoDB shim (539 lines) is YAGNI with one impl; inline db.exec when second backend appears
import { invoke } from '@tauri-apps/api/core';
import { listen, type UnlistenFn } from '@tauri-apps/api/event';
import { decode } from "@msgpack/msgpack";

// --- Types & Interfaces ---
export type HakoPrimitive = 
  | string | number | boolean | null | Uint8Array | Date
  | { [key: string]: HakoPrimitive } 
  | HakoPrimitive[];

export type HakoRecord = Record<string, any>;

export type FilterOperator = 
  | 'eq' | 'ne' | 'gt' | 'gte' | 'lt' | 'lte' 
  | 'match' | 'matchPrefix' | 'contains' | 'startsWith' | 'in' | 'notIn' 
  | 'arrayContains' | 'arrayContainsAny';

export interface SetOptions {
    merge?: boolean;
}

export type AggregateKind = 'count' | 'sum' | 'avg' | 'min' | 'max';

export type VectorMetric = 'cosine' | 'l2' | 'inner_product';

export type TraverseDirection = 'outgoing' | 'incoming' | 'both';

export interface NearHit {
    id: string;
    /** Exact metric distance (lower = nearer; cosine in [0,2], l2 squared). */
    score: number;
    doc: DocumentSnapshot;
}

export interface PathHit {
    collection: string;
    id: string;
    /** BFS hops from the anchor. */
    depth: number;
    /** Accumulated cost (BFS: hops; Dijkstra: weight sum). */
    cost?: number;
    doc: DocumentSnapshot;
    /** Full discovery path start->hit (findPaths/findSimplePaths with
     * includePath; absent otherwise). */
    path?: { collection: string; id: string }[];
    /** Edge doc per hop, aligned with `path` hops (includeVia; null for
     * inline-reference hops). */
    via?: (string | null)[];
}

export interface AuditEntry {
    op: string;
    collection: string;
    doc_id?: string; // Corrected to snake_case for Rust
    ok: boolean;
}

// --- Add these interfaces for the Delta Protocol ---
interface DeltaChange {
    kind: 'full' | 'update' | 'delete';
    doc_id: string;
    data?: any;
}

interface DeltaPayload {
    listener_id: string;
    changes: DeltaChange[];
}

function symToOp(sym: string): string {
    switch (sym) {
        case '==': return 'eq';
        case '!=': return 'ne';
        case '>': return 'gt';
        case '>=': return 'gte';
        case '<': return 'lt';
        case '<=': return 'lte';
        // Rust FilterOperator deserializes with rename_all = "snake_case",
        // so camelCase ops used at the call site are mapped to snake_case.
        case 'matchPrefix': return 'match_prefix';
        case 'startsWith': return 'starts_with';
        case 'notIn': return 'not_in';
        case 'arrayContains': return 'array_contains';
        case 'arrayContainsAny': return 'array_contains_any';
        default: return sym;
    }
}

// --- Internal Utilities ---
function generateId() {
    return Math.random().toString(36).substring(2, 15) + Math.random().toString(36).substring(2, 15);
}

function normalizeValue(v: any): any {
    if (v === null || typeof v !== 'object') return v; // Fast path for primitives
    
    if (v instanceof Uint8Array) {
        return v;
    }
    if (v instanceof Date) return v.getTime() * 1000;
    
    if (Array.isArray(v)) {
        return v.map(normalizeValue);
    }

    const out: any = {};
    for (const key in v) {
        out[key] = normalizeValue(v[key]);
    }
    return out;
}

async function exec(op: any): Promise<any> {
    // Note: The 'op' field inside the payload is the variant tag
    // The other fields must match the Rust struct fields (snake_case)
    const bytes = await invoke<number[]>('hako_exec', { op });
    const res = decode(new Uint8Array(bytes)) as any;
    if (res?.error) throw new Error(res.error);
    return res;
}

// --- Core Classes ---
export class Hako {}

export class DocumentReference {
    constructor(public readonly collectionPath: string, public readonly id: string) {}
    get path() { return `${this.collectionPath}/${this.id}`; }
}

export class CollectionReference {
    readonly type = 'collection' as const;
    constructor(public readonly path: string) {}
}

export class CollectionGroupReference {
    readonly type = 'collectionGroup' as const;
    constructor(public readonly id: string) {}
}

export class DocumentSnapshot {
    public readonly id: string; 
    public readonly _time: number;
    private _cachedData?: HakoRecord;

    constructor(
        id: string, 
        private readonly _exists: boolean, 
        private readonly _data?: HakoRecord,
        private readonly _ref?: DocumentReference
    ) {
        // Use the ID from data if the provided ID is null (common in queries)
        this.id = id;
        this._time = (_data as any)?._time || 0;
    }
    
    get ref() { return this._ref; }
    exists() { return this._exists; }

    data(): HakoRecord | undefined { 
        if (!this._data) return undefined;
        
        if (!this._cachedData) {
            this._cachedData = { ...this._data, id: this.id };
        }
        return this._cachedData;
    }

}

export interface DocumentChange {
    type: 'added' | 'modified' | 'removed';
    doc: DocumentSnapshot;
}

export class QuerySnapshot {
    constructor(public readonly docs: DocumentSnapshot[], private readonly _changes: DocumentChange[] = []) {}
    get empty() { return this.docs.length === 0; }
    get size() { return this.docs.length; }
    docChanges() { return this._changes; }
    forEach(callback: (doc: DocumentSnapshot) => void) { this.docs.forEach(callback); }
}

export type QueryConstraintType = 'where' | 'order_by' | 'limit' | 'offset' | 'select' | 'start_at' | 'start_after' | 'end_at' | 'end_before' | 'or' | 'defer_blobs' | 'local_only';

export class QueryConstraint {
    constructor(public readonly type: QueryConstraintType, public readonly data: any) {}
}

export class Query {
    readonly type = 'query' as const;
    constructor(
        public readonly colRef: CollectionReference | CollectionGroupReference, 
        public readonly constraints: QueryConstraint[] = []
    ) {}
}

// --- API Implementation ---
export const getFirestore = () => new Hako();

export const collection = (_db: any, path: string) => new CollectionReference(path);

export const doc = (_db: any, colOrPath: string | CollectionReference, id?: string) => {
    if (typeof colOrPath === 'string') {
        const segments = colOrPath.split('/').filter(Boolean);
        if (id) return new DocumentReference(colOrPath, id);

        const docId = segments.pop()!;
        const colPath = segments.join('/');
        return new DocumentReference(colPath, docId);
        // return new DocumentReference(segments[0], segments[1]);
    }
    return new DocumentReference(colOrPath.path, id!);
};

// --- Write Operations ---
export const addDoc = async (colRef: CollectionReference, data: HakoRecord) => {
    // Send an empty string as doc_id to trigger Rust-side generation
    const res = await exec({ 
        op: 'set', 
        collection: colRef.path, 
        doc_id: data.id||"", 
        data: normalizeValue(data) 
    });
    // The Rust backend now returns the generated ID in the response
    return new DocumentReference(colRef.path, res.id);
};

export const setDoc = async (ref: DocumentReference, data: HakoRecord, options?: SetOptions) => {
    const op = options?.merge ? 'patch' : 'set';
    await exec({ op, collection: ref.collectionPath, doc_id: ref.id, data: normalizeValue(data) });
};

export const updateDoc = async (ref: DocumentReference, data: Partial<HakoRecord>) => {
    await exec({ op: 'patch', collection: ref.collectionPath, doc_id: ref.id, data: normalizeValue(data) });
};

export const updateDocs = async (
    q: Query | CollectionReference | CollectionGroupReference, 
    data: Partial<HakoRecord>
) => {
    const params = buildQueryParams(q);
    const res = await exec({ 
        op: 'query', 
        action: { patch: { data: normalizeValue(data) } }, 
        ...params 
    });
    return res.bulk_action_result.count;
};

export const deleteDoc = async (ref: DocumentReference, options?: { localOnly?: boolean; force?: boolean }) => {
    await exec({ op: 'delete', collection: ref.collectionPath, doc_id: ref.id, local_only: options?.localOnly ?? false, force: options?.force ?? false });
};

/** Undo a soft delete: the doc is live again (fresh version), while the
 * tombstone history stays for peers to reconcile. */
export const restoreDoc = async (ref: DocumentReference) => {
    await exec({ op: 'restore', collection: ref.collectionPath, doc_id: ref.id });
};

/** Soft-deleted docs still inside their retention window (restorable),
 * across all collections or one. Raw retention records. */
export const restoreAvailable = async (collection?: string): Promise<any> => {
    const res = await exec({ op: 'restore_available', ...(collection ? { collection } : {}) });
    return res.records.list;
};

/** Soft-deleted docs due for the sweeper purge, across all collections or
 * one. Raw retention records — the restore half of this list is finite. */
export const deleteQueue = async (collection?: string): Promise<any> => {
    const res = await exec({ op: 'delete_queue', ...(collection ? { collection } : {}) });
    return res.records.list;
};

/** Vacuum a collection: purge tombstones locally (never replicates); the
 * next handshake pulls peer state. The restore half of a local reset. */
export const vacuumCollection = async (collectionPath: string) => {
    const res = await exec({ op: 'vacuum', collection: collectionPath });
    return res.bulk_action_result.count;
};

/** Run one sweeper pass now: purge soft-deleted docs past their retention
 * window across all collections. Returns the purged record count. */
export const sweepNow = async () => {
    const res = await exec({ op: 'sweep' });
    return res.bulk_action_result.count;
};

export const deleteDocs = async (
    q: Query | CollectionReference | CollectionGroupReference,
    options?: { localOnly?: boolean }
) => {
    const params = buildQueryParams(q);
    const res = await exec({
        op: 'query',
        action: 'delete',
        ...params,
        // Explicit option wins over the localOnly() constraint.
        local_only: options?.localOnly ?? params.local_only ?? false
    });
    return res.bulk_action_result.count;
};

export const getDoc = async (ref: DocumentReference) => {
    const res = await exec({ op: 'get', collection: ref.collectionPath, doc_id: ref.id });
    const data = res.document?.data;
    return new DocumentSnapshot(ref.id, !!data, data ?? undefined, ref);
};

// --- Querying ---
export const query = (colRef: CollectionReference | CollectionGroupReference, ...constraints: QueryConstraint[]) => 
    new Query(colRef, constraints);

export const where = (field: string, op: FilterOperator, value: any) => new QueryConstraint('where', { field, op, value });
export const or = (...constraints: QueryConstraint[]) => new QueryConstraint('or', constraints);
export const orderBy = (field: string, direction: 'asc' | 'desc' = 'asc') => new QueryConstraint('order_by', { field, ascending: direction === 'asc' });
export const limit = (n: number) => new QueryConstraint('limit', n);
export const offset = (n: number) => new QueryConstraint('offset', n);
export const select = (...fields: string[]) => new QueryConstraint('select', fields);
export const startAt = (...values: any[]) => new QueryConstraint('start_at', values);
export const startAfter = (...values: any[]) => new QueryConstraint('start_after', values);
export const endAt = (...values: any[]) => new QueryConstraint('end_at', values);
export const endBefore = (...values: any[]) => new QueryConstraint('end_before', values);
// Blob-backed fields come back as __blob__ placeholders (no blob-file
// reads); resolve per doc with a getDoc. List views over image docs.
export const deferBlobs = () => new QueryConstraint('defer_blobs', true);
// Local-only scope for deleteDocs: matched docs never leave this device.
export const localOnly = () => new QueryConstraint('local_only', true);

export const getDocs = async (q: Query | CollectionReference | CollectionGroupReference) => {
    const params = buildQueryParams(q);
    const res = await exec({ 
        op: 'query', 
        action: 'fetch', // Explicitly request data
        ...params 
    });
    const docs = res.query_result.rows.map((r: any) => new DocumentSnapshot(r.id || generateId(), true, r));
    return new QuerySnapshot(docs);
};

/** One raw row: id in the clear, storage bytes opaque. */
export interface RawRow {
    id: string;
    bytes: Uint8Array;
}

/**
 * Raw scan (v0.8.7+): no server decode, no JSON per row. Hash/count/export
 * bytes client-side, page with startAfter([lastId]) under an id order,
 * decode selected rows with decodeRawDoc. Bytes cross msgpack as bin.
 */
export const getRawDocs = async (q: Query | CollectionReference | CollectionGroupReference): Promise<RawRow[]> => {
    const params = buildQueryParams(q);
    const res = await exec({
        op: 'query_raw',
        ...params
    });
    return (res.raw_result.rows as any[]).map((r: any) => ({ id: r.id as string, bytes: r.bytes as Uint8Array }));
};

/**
 * Decode one raw row server-side (blobs inflated). The bytes must be an
 * exact stored row from getRawDocs — never hand-built. Crosses as a JSON
 * number array (invoke args are JSON); prefer it for selected rows, not
 * bulk transfer.
 */
export const decodeRawDoc = async (collectionPath: string, docId: string, bytes: Uint8Array) => {
    const res = await exec({ op: 'decode_raw', collection: collectionPath, doc_id: docId, bytes: Array.from(bytes) });
    const data = res.document?.data;
    return new DocumentSnapshot(docId, !!data, data ?? undefined);
};

/** True once background index recovery finishes (poll before cursor paging). */
export const isIndexesReady = async (): Promise<boolean> => {
    const res = await exec({ op: 'indexes_ready' });
    return !!res.ready?.ready;
};

/**
 * Lazy typed field pull (no decode, no JSON document). Returns the JSON
 * value or null/undefined when missing. BlobLink fields surface their
 * placeholder — decodeRawDoc the row when needed.
 */
export const viewGetField = async (collectionPath: string, docId: string, field: string): Promise<any> => {
    const res = await exec({ op: 'view_get_field', collection: collectionPath, doc_id: docId, field });
    return res.value_result?.value ?? undefined;
};

// --- Aggregations ---
export const getCountFromServer = async (q: Query | CollectionReference | CollectionGroupReference) => {
    const params = buildQueryParams(q);
    const res = await exec({ op: 'aggregate', kind: 'count', ...params });
    return { data: () => ({ count: res.aggregate_result.value }) };
};

export function onSnapshot(
    ref: DocumentReference,
    onNext: (snapshot: DocumentSnapshot) => void,
    onError?: (error: any) => void
): () => void;

export function onSnapshot(
    ref: Query | CollectionReference | CollectionGroupReference,
    onNext: (snapshot: QuerySnapshot) => void,
    onError?: (error: any) => void
): () => void;

export function onSnapshot(
    q: Query | CollectionReference | CollectionGroupReference | DocumentReference, 
    onNext: (snapshot: any) => void,
    onError?: (error: any) => void
) {
    const isDoc = q instanceof DocumentReference;
    const listener_id = `fl_${Date.now()}_${Math.random().toString(36).slice(2)}`;
    const event_name = `hako://snapshot/${listener_id}`;
    const params = buildQueryParams(q);

    // 1. Local state (Raw values)
    const localCache = new Map<string, any>();
    let unlisten: UnlistenFn;

    const start = async () => {
        try {
            unlisten = await listen<Uint8Array>(event_name, (event) => {

                // const payload = decode(event.payload) as DeltaPayload;
                const payload = decode(new Uint8Array(event.payload)) as DeltaPayload;
                const { changes } = payload;
                
                // const { changes } = event.payload;
                let hasChanged = false;

                changes.forEach(change => {
                    const { kind, doc_id, data } = change;
                    const existing = localCache.get(doc_id);
                    
                    const oldTime = existing?._time || 0;
                    const newTime = data?._time || 0;

                    if (kind === 'full') {
                        localCache.clear();
                        (data as any[]).forEach(r => localCache.set(r.id.toString(), r));
                        hasChanged = true;
                    } 
                    else if (kind === 'update') {
                        // LWW when the delta carries a timestamp; deltas without
                        // one are always accepted so the UI can never be left
                        // stranded on a stale row.
                        if (newTime === 0 || newTime >= oldTime) {
                            localCache.set(doc_id, data);
                            hasChanged = true;
                        }
                    } 
                    else if (kind === 'delete') {
                        // Same rule as updates: never strand stale rows.
                        if (!existing || newTime === 0 || newTime >= oldTime) {
                            localCache.delete(doc_id);
                            hasChanged = true;
                        }
                    }
                });

                if (!hasChanged) return;

                // 2. TERMINAL ACTION: Emit to UI
                if (isDoc) {
                    const docData = localCache.get((q as DocumentReference).id);
                    onNext(new DocumentSnapshot((q as DocumentReference).id, !!docData, docData, q as DocumentReference));
                } else {
                    // Optimized Re-sorting: Only if order_by is present
                    let results = Array.from(localCache.values());
                    
                    if (params.order_by && Array.isArray(params.order_by)) {
                        results.sort((a, b) => {
                            for (const order of params.order_by||[]) {
                                const { field, ascending } = order;
                                const valA = a[field];
                                const valB = b[field];

                                if (valA === valB) continue;

                                const cmp = valA < valB ? -1 : 1;
                                return ascending ? cmp : -cmp;
                            }
                            return 0;
                        });
                    }

                    if (params.offset || params.limit) {
                        const start = params.offset || 0;
                        results = results.slice(start, params.limit ? start + params.limit : undefined);
                    }

                    const snapshots = results.map(r => new DocumentSnapshot(r.id.toString(), true, r));
                    onNext(new QuerySnapshot(snapshots));
                }
            });

            await exec({ op: 'subscribe', listener_id, event_name, ...params });
        } catch (err) {
            onError?.(err);
        }
    };

    start();
    return () => {
        if (unlisten) unlisten();
        exec({ op: 'unsubscribe', listener_id }).catch(() => {});
    };
}

// --- Transactions & Batches ---
export const writeBatch = (_db: Hako) => {
    const mutations: any[] = [];
    return {
        set: (ref: DocumentReference, data: HakoRecord) => 
            mutations.push({ mutation: 'set', collection: ref.collectionPath, doc_id: ref.id, data: normalizeValue(data) }),
        update: (ref: DocumentReference, data: Partial<HakoRecord>) => 
            mutations.push({ mutation: 'patch', collection: ref.collectionPath, doc_id: ref.id, data: normalizeValue(data) }),
        delete: (ref: DocumentReference, options?: { localOnly?: boolean; force?: boolean }) =>
            mutations.push({
                mutation: 'delete',
                collection: ref.collectionPath,
                doc_id: ref.id,
                local_only: options?.localOnly ?? false,
                force: options?.force ?? false
            }),
        commit: async () => exec({ op: 'batch', mutations })
    };
};

export const runTransaction = async (
  _db: Hako,
  updateFunction: (transaction: any) => Promise<any>
) => {
  const mutations: any[] = [];

  const transaction = {
    get: async (ref: DocumentReference) => {
      return await getDoc(ref);
    },

    set: (ref: DocumentReference, data: any) =>
      mutations.push({
        mutation: 'set',
        collection: ref.collectionPath,
        doc_id: ref.id,
        data: normalizeValue(data)
      }),

    update: (ref: DocumentReference, data: any) =>
      mutations.push({
        mutation: 'patch',
        collection: ref.collectionPath,
        doc_id: ref.id,
        data: normalizeValue(data)
      }),

    delete: (ref: DocumentReference, options?: { localOnly?: boolean; force?: boolean }) =>
      mutations.push({
        mutation: 'delete',
        collection: ref.collectionPath,
        doc_id: ref.id,
        local_only: options?.localOnly ?? false,
        force: options?.force ?? false
      })
  };

  const result = await updateFunction(transaction);

  await exec({
    op: 'batch',
    mutations
  });

  return result;
};

// --- Indexing ---
export const createIndex = async (colOrPath: string | CollectionReference, field: string) => {
    const collection = typeof colOrPath === 'string' ? colOrPath : colOrPath.path;
    return exec({ op: 'create_index', collection, field });
};

export const createFtsIndex = async (colOrPath: string | CollectionReference, field: string) => {
    const collection = typeof colOrPath === 'string' ? colOrPath : colOrPath.path;
    return exec({ op: 'create_fts_index', collection, field });
};

export const createCompositeIndex = async (
  colOrPath: string | CollectionReference,
  fields: { field: string; desc?: boolean }[]
) => {
  const collection =
    typeof colOrPath === 'string' ? colOrPath : colOrPath.path;

  return exec({
    op: 'create_composite_index',
    collection,
    fields
  });
};

export interface HnswParams {
    /** Omitted/0: per-dim derived default. Persisted in the index def. */
    m?: number;
    efConstruction?: number;
    efSearch?: number;
    /** Popcount stage-1 (#190); omitted = int8 stage-1. */
    binaryStage1?: boolean;
}

export const createVectorIndex = async (
  colOrPath: string | CollectionReference,
  field: string,
  dim: number,
  metric: VectorMetric = 'cosine',
  params?: HnswParams
) => {
  const collection =
    typeof colOrPath === 'string' ? colOrPath : colOrPath.path;

  return exec({
    op: 'create_vector_index',
    collection,
    field,
    dim,
    metric,
    ...(params?.m ? { m: params.m } : {}),
    ...(params?.efConstruction ? { ef_construction: params.efConstruction } : {}),
    ...(params?.efSearch ? { ef_search: params.efSearch } : {}),
    ...(params?.binaryStage1 ? { binary_stage1: true } : {})
  });
};

/** KNN search: nearest-first [{id, score, doc}]. Accepts number[] or Float32Array.
 * opts.maxDistance keeps only hits at or under the bound; opts.filters run
 * hybrid search (ANN + predicates in one query). */
export const findNear = async (
  colOrPath: string | CollectionReference,
  field: string,
  query: number[] | Float32Array,
  k = 10,
  opts?: { maxDistance?: number; filters?: FilterInput[] }
): Promise<NearHit[]> => {
  const collection =
    typeof colOrPath === 'string' ? colOrPath : colOrPath.path;

  const res = await exec({
    op: 'find_near',
    collection,
    field,
    // invoke args are JSON: Float32Array would not survive, flatten first.
    query: Array.from(query),
    k,
    ...(opts?.maxDistance !== undefined ? { max_distance: opts.maxDistance } : {}),
    ...(opts?.filters?.length ? { filters: opts.filters } : {})
  });
  return (res.near_result.hits as any[]).map((h) => ({
    id: h.id as string,
    score: h.score as number,
    doc: new DocumentSnapshot(h.id as string, true, h.doc)
  }));
};

export const createTraverseIndex = async (
  colOrPath: string | CollectionReference
) => {
  const collection =
    typeof colOrPath === 'string' ? colOrPath : colOrPath.path;

  return exec({ op: 'create_traverse_index', collection });
};

/** Graph BFS from a doc: [{collection, id, depth, doc}] in walk order.
 * opts.nodeMatch/edgeType/edgeMatch prune the walk; includePath/includeVia
 * fill the hit's path/via route projections. */
export const findPaths = async (
  colOrPath: string | CollectionReference,
  docId: string,
  direction: TraverseDirection = 'outgoing',
  edge: string | null = null,
  maxDepth = 10,
  k = 100,
  via: string | null = null,
  weight: string | null = null,
  opts?: TraverseOptions
): Promise<PathHit[]> => {
  const collection =
    typeof colOrPath === 'string' ? colOrPath : colOrPath.path;

  const res = await exec({
    op: 'find_paths',
    collection,
    doc_id: docId,
    direction,
    ...(edge === null ? {} : { edge }),
    max_depth: maxDepth,
    k,
    ...(via === null ? {} : { via }),
    ...(weight === null ? {} : { weight }),
    ...traverseOpts(opts)
  });
  return (res.path_result.hits as any[]).map((h) => ({
    collection: h.collection as string,
    id: h.id as string,
    depth: h.depth as number,
    cost: h.cost as number,
    doc: new DocumentSnapshot(h.id as string, true, h.doc),
    ...(h.path ? { path: h.path } : {}),
    ...(h.via ? { via: h.via } : {})
  }));
};

export const createEdgeIndex = async (
  colOrPath: string | CollectionReference
) => {
  const collection =
    typeof colOrPath === 'string' ? colOrPath : colOrPath.path;

  return exec({ op: 'create_edge_index', collection });
};

export const listIndexes = async (collection?: string) => {
  const res = await exec({
    op: 'list_indexes',
    collection
  });
  return res.indexes.list;
};

export const snapshotIndices = async () =>
  exec({ op: 'snapshot_indices' });

/** Flush WAL + segments to disk (close path, deterministic tests). */
export const flushDatabase = async () =>
  exec({ op: 'flush' });

/** Doc ids in a collection (key scans for seeding, archive passes, stats). */
export const listStorageKeys = async (
  colOrPath: string | CollectionReference
): Promise<string[]> => {
  const collection =
    typeof colOrPath === 'string' ? colOrPath : colOrPath.path;

  const res = await exec({ op: 'list_storage_keys', collection });
  return res.storage_keys.ids as string[];
};

// --- Admin ---
export const listCollections = async () => {
    const res = await exec({ op: 'list_collections' });
    return res.collections.names;
};

/** Move docs between collections (archive/restore). Returns {moved, missing}. */
export const relocateDocs = async (src: string, dst: string, ids: string[]) => {
    const res = await exec({ op: 'relocate_docs', src, dst, ids });
    return res.relocate_result as { moved: string[]; missing: string[] };
};

/** Explicit load of one (usually lazy archive) collection. */
export const loadCollection = async (collection: string) =>
    exec({ op: 'load_collection', collection });

/** Explicit evict of one lazy collection (refuses non-lazy). */
export const unloadCollection = async (collection: string) =>
    exec({ op: 'unload_collection', collection });

/** Archive-group collections on disk but not loaded. */
export const unloadedCollections = async () => {
    const res = await exec({ op: 'unloaded_collections' });
    return res.collections.names as string[];
};

export const getStats = async () => {
    const res = await exec({ op: 'get_stats' });
    return res.stats.details;
};

/** Cheap existence probe; never materializes the collection. */
export const docExists = async (collection: string, docId: string): Promise<boolean> => {
    const res = await exec({ op: 'exists', collection, doc_id: docId });
    return !!res.exists?.exists;
};

/** Compact one resident collection; absent/unloaded collections are a no-op. */
export const compactCollection = async (collection: string) =>
    exec({ op: 'compact_collection', collection });

/** Compact the whole database (every resident shard). */
export const compact = async () => exec({ op: 'compact' });

/** Write a full backup of the local database to a device-local file path. */
export const backup = async (path: string) => exec({ op: 'backup', path });


function buildQueryParams(q: Query | CollectionReference | CollectionGroupReference | DocumentReference) {
    // 1. Handle single DocumentReference (e.g., doc(db, 'users', '123'))
    if (q instanceof DocumentReference) {
        return {
            collection: q.collectionPath,
            doc_id_filter: q.id, // Explicit ID filter for the Rust loop
            filters: [],
            or_groups: undefined,
            order_by: undefined,
            limit: undefined,
            offset: undefined,
            projection: undefined,
            start_at: undefined,
            start_after: undefined,
            end_at: undefined,
            end_before: undefined,
            defer_blobs: false,
            local_only: false
        };
    }

    // 2. Normalize input: if it's a raw CollectionRef, wrap it in a Query object
    const queryObj = (q as any).constraints ? (q as Query) : new Query(q as any);
    
    const filters: any[] = [];
    const or_groups: any[][] = [];
    let order_by: any[] = [];
    let limit: number | undefined = undefined;
    let offset: number | undefined = undefined;
    let projection: string[] | undefined = undefined;
    let start_at: any[] | undefined = undefined;
    let start_after: any[] | undefined = undefined;
    let end_at: any[] | undefined = undefined;
    let end_before: any[] | undefined = undefined;
    let defer_blobs = false;
    let local_only = false;

    // 3. Extract all constraints from the query object
    for (const c of queryObj.constraints) {
        switch (c.type) {
            case 'where': 
                filters.push({ 
                    field: c.data.field, 
                    op: symToOp(c.data.op), 
                    value: normalizeValue(c.data.value) 
                }); 
                break;
            case 'or': 
                or_groups.push(c.data.map((cc: any) => ({ 
                    field: cc.data.field, 
                    op: symToOp(cc.data.op), 
                    value: normalizeValue(cc.data.value) 
                }))); 
                break;
            case 'order_by': order_by.push(c.data); break;
            case 'limit': limit = c.data; break;
            case 'offset': offset = c.data; break;
            case 'select': projection = c.data; break;
            case 'start_at': start_at = c.data.map(normalizeValue); break;
            case 'start_after': start_after = c.data.map(normalizeValue); break;
            case 'end_at': end_at = c.data.map(normalizeValue); break;
            case 'end_before': end_before = c.data.map(normalizeValue); break;
            case 'defer_blobs': defer_blobs = true; break;
            case 'local_only': local_only = true; break;
        }
    }

    // 4. Resolve the collection name/path
    const collection = queryObj.colRef instanceof CollectionReference 
        ? queryObj.colRef.path 
        : (queryObj.colRef as any).id;

    // 5. Return the payload structured for the Rust QueryInput struct
    return {
        collection,
        doc_id_filter: undefined, // Not used for collection-wide queries
        filters,
        or_groups: or_groups.length > 0 ? or_groups : undefined,
        order_by: order_by.length > 0 ? order_by : undefined,
        limit,
        offset,
        projection,
        start_at,
        start_after,
        end_at,
        end_before,
        defer_blobs,
        local_only
    };
}


export const getSumFromServer = async (
  q: Query | CollectionReference | CollectionGroupReference,
  field: string
) => {
  const params = buildQueryParams(q);
  const res = await exec({
    op: 'aggregate',
    kind: 'sum',
    field,
    ...params
  });
  return { data: () => ({ value: res.aggregate_result.value }) };
};

export const getAverageFromServer = async (
  q: Query | CollectionReference | CollectionGroupReference,
  field: string
) => {
  const params = buildQueryParams(q);
  const res = await exec({
    op: 'aggregate',
    kind: 'avg',
    field,
    ...params
  });
  return { data: () => ({ value: res.aggregate_result.value }) };
};

/** `null` when no matching document has a numeric `field`. */
export const getMinFromServer = async (
  q: Query | CollectionReference | CollectionGroupReference,
  field: string
) => {
  const params = buildQueryParams(q);
  const res = await exec({
    op: 'aggregate',
    kind: 'min',
    field,
    ...params
  });
  return { data: () => ({ value: res.aggregate_result.value ?? null }) };
};

/** `null` when no matching document has a numeric `field`. */
export const getMaxFromServer = async (
  q: Query | CollectionReference | CollectionGroupReference,
  field: string
) => {
  const params = buildQueryParams(q);
  const res = await exec({
    op: 'aggregate',
    kind: 'max',
    field,
    ...params
  });
  return { data: () => ({ value: res.aggregate_result.value ?? null }) };
};

export const setDurability = (mode: 'always' | 'interval' | 'manual' | 'on_commit') => {
    const modes = { always: 0, interval: 1, manual: 2, on_commit: 3 };
    return exec({ op: 'set_durability', mode: modes[mode] });
};

/**
 * Live group-commit window in ms (Interval mode), clamped server-side
 * (1..=30000). Requires backend with the runtime setter (hakodb 0.10+,
 * hakotauri 0.4+); older backends reject the op — detect via catch,
 * not version sniffing.
 */
export const setGroupCommitInterval = (ms: number) => {
    return exec({ op: 'set_group_commit_interval', ms });
};

export const setCompression = (enabled: boolean, level: number = 3) => {
    // NOTE: engine-managed no-op by design — the backend accepts and
    // ignores it (compression policy lives in the engine, not per call).
    // Kept wired (not deprecated) so callsites keep compiling; do not
    // expect any behavior change from toggling it.
    return exec({ op: 'set_compression', enabled, level });
};

export const getAuditLog = async (): Promise<AuditEntry[]> => {
    const res = await exec({ op: 'get_audit_log' });
    return res.audit_log.entries;
};

// --- 0.19.4 parity: transactions, pipeline, graph breadth, admin ops ---

/** One (field, value) predicate, same wire shape as query filters. */
export interface FilterInput {
    field: string;
    op: FilterOperator;
    value: any;
}

/** Traversal routing/filtering: nodeMatch prunes at expansion,
 * edgeType routes edge-collection hops (e.g. ("type", "follows")),
 * edgeMatch filters edge properties (ANDs with edgeType). */
export interface PropMatch { field: string; value: any; }

export interface TraverseOptions {
    nodeMatch?: PropMatch;
    edgeType?: PropMatch;
    edgeMatch?: PropMatch;
    includePath?: boolean;
    includeVia?: boolean;
}

function traverseOpts(opts?: TraverseOptions) {
    return {
        ...(opts?.nodeMatch ? { node_match: opts.nodeMatch } : {}),
        ...(opts?.edgeType ? { edge_type: opts.edgeType } : {}),
        ...(opts?.edgeMatch ? { edge_match: opts.edgeMatch } : {}),
        ...(opts?.includePath ? { include_path: true } : {}),
        ...(opts?.includeVia ? { include_via: true } : {})
    };
}

export type DropIndexKind = 'simple' | 'fts' | 'vector' | 'traverse' | 'edge' | 'composite';

export type GraphAnalysisKind = 'components' | 'cycle' | 'topo' | 'degrees';

export type TxnStepKind = 'get' | 'set' | 'patch' | 'delete';

/** One step inside a transaction, run in order under one snapshot.
 * force (delete only): true = legacy hard delete, false = soft (default). */
export interface TxnStep {
    kind: TxnStepKind;
    collection: string;
    doc_id: string;
    /** Set/Patch payload (ignored by Get/Delete). */
    data?: any;
    force?: boolean;
}

/** One pipeline stage. `match` replaces the row set (a full query shape);
 * every other stage transforms it. */
export type StageInput =
    | { stage: 'match'; filters?: FilterInput[]; or_groups?: FilterInput[][]; order_by?: { field: string; ascending?: boolean }[]; limit?: number; offset?: number; projection?: string[]; start_at?: any[]; start_after?: any[]; end_at?: any[]; end_before?: any[]; doc_id_filter?: string }
    | { stage: 'project'; fields: string[] }
    | { stage: 'sort'; field: string; ascending?: boolean }
    | { stage: 'limit'; n: number }
    | { stage: 'offset'; n: number }
    | { stage: 'unwind'; field: string }
    | { stage: 'group'; key?: string; accums: { out: string; kind: AggregateKind; field?: string }[] };

export interface DropResult {
    docs_removed: number;
    bytes_reclaimed: number;
    collections_dropped: string[];
}

export interface QuiescenceStatus {
    indexes_ready: boolean;
    pending_index_ops: number;
    index_backfills: number;
    pending_blob_bytes: number;
    queued_blob_items: number;
    maintenance_running: boolean;
}

/**
 * Serializable read-modify-write with bounded retry: the whole step list
 * re-runs on a fresh snapshot when a read-set conflict is detected.
 * Returns the docs read by `get` steps (aligned in step order; null =
 * absent at snapshot). `maxAttempts` defaults to 3.
 */
export const execTransaction = async (
    steps: TxnStep[],
    maxAttempts = 3
): Promise<(HakoRecord | null)[]> => {
    const res = await exec({ op: 'transaction', steps, max_attempts: maxAttempts });
    return res.transaction_result.docs as any[];
};

/** Multi-stage aggregation pipeline over one collection. Returns plain
 * rows (match stage ordering differs from getDocs' DocumentSnapshot). */
export const runPipeline = async (
    colOrPath: string | CollectionReference,
    stages: StageInput[]
): Promise<HakoRecord[]> => {
    const collection = typeof colOrPath === 'string' ? colOrPath : colOrPath.path;
    const res = await exec({ op: 'pipeline', collection, stages });
    return res.query_result.rows as HakoRecord[];
};

/** Drop one index definition: simple/fts/vector need `field`, composite
 * needs `id` (from listIndexes), traverse/edge need the collection only. */
export const dropIndex = async (
    colOrPath: string | CollectionReference,
    kind: DropIndexKind,
    opts?: { field?: string; id?: number }
) => {
    const collection = typeof colOrPath === 'string' ? colOrPath : colOrPath.path;
    return exec({
        op: 'drop_index',
        kind,
        collection,
        ...(opts?.field ? { field: opts.field } : {}),
        ...(opts?.id !== undefined ? { id: opts.id } : {})
    });
};

/** Batched KNN (#141-5): one readiness cycle for many query vectors.
 * Results align 1:1 with `queries`, each nearest-first. */
export const findNearBatch = async (
    colOrPath: string | CollectionReference,
    field: string,
    queries: (number[] | Float32Array)[],
    k = 10
): Promise<NearHit[][]> => {
    const collection = typeof colOrPath === 'string' ? colOrPath : colOrPath.path;
    const res = await exec({
        op: 'find_near_batch',
        collection,
        field,
        queries: queries.map((q) => Array.from(q)),
        k
    });
    return (res.near_batch_result.results as any[][]).map((hits) =>
        hits.map((h) => ({
            id: h.id as string,
            score: h.score as number,
            doc: new DocumentSnapshot(h.id as string, true, h.doc)
        }))
    );
};

/** Cycle-safe simple-path enumeration (no node revisits), same wire
 * shape as findPaths. */
export const findSimplePaths = async (
    colOrPath: string | CollectionReference,
    docId: string,
    direction: TraverseDirection = 'outgoing',
    edge: string | null = null,
    maxDepth = 10,
    k = 100,
    via: string | null = null,
    weight: string | null = null,
    opts?: TraverseOptions
): Promise<PathHit[]> => {
    const collection = typeof colOrPath === 'string' ? colOrPath : colOrPath.path;
    const res = await exec({
        op: 'find_simple_paths',
        collection,
        doc_id: docId,
        direction,
        ...(edge === null ? {} : { edge }),
        max_depth: maxDepth,
        k,
        ...(via === null ? {} : { via }),
        ...(weight === null ? {} : { weight }),
        ...traverseOpts(opts)
    });
    return (res.path_result.hits as any[]).map((h) => ({
        collection: h.collection as string,
        id: h.id as string,
        depth: h.depth as number,
        cost: h.cost as number,
        doc: new DocumentSnapshot(h.id as string, true, h.doc),
        ...(h.path ? { path: h.path } : {}),
        ...(h.via ? { via: h.via } : {})
    }));
};

/** Whole-graph algorithms over the collection's adjacency:
 * components (labelled groups), cycle (one directed cycle or null),
 * topo (topological order or null), degrees (out/in per node). */
export const graphAnalysis = async (
    colOrPath: string | CollectionReference,
    kind: GraphAnalysisKind,
    opts?: { direction?: TraverseDirection; edge?: string; via?: string; nodeMatch?: PropMatch }
): Promise<any> => {
    const collection = typeof colOrPath === 'string' ? colOrPath : colOrPath.path;
    const res = await exec({
        op: 'graph_analysis',
        collection,
        kind,
        direction: opts?.direction ?? 'outgoing',
        ...(opts?.edge ? { edge: opts.edge } : {}),
        ...(opts?.via ? { via: opts.via } : {}),
        ...(opts?.nodeMatch ? { node_match: opts.nodeMatch } : {})
    });
    return res.value_result.value;
};

/** Export one collection's graph as viz-ready JSON (nodes + edges). */
export const exportGraph = async (
    colOrPath: string | CollectionReference,
    opts?: { direction?: TraverseDirection; edge?: string; via?: string }
): Promise<any> => {
    const collection = typeof colOrPath === 'string' ? colOrPath : colOrPath.path;
    const res = await exec({
        op: 'export_graph',
        collection,
        direction: opts?.direction ?? 'outgoing',
        ...(opts?.edge ? { edge: opts.edge } : {}),
        ...(opts?.via ? { via: opts.via } : {})
    });
    return res.value_result.value;
};

/** Personalized PageRank: teleport mass `1 - damping` on the seed set
 * (`seeds` = ["col/id"] or null for classic PageRank). damping 0 = engine
 * default 0.85; top 0 = all nodes. Rows [{node, score}] score desc. */
export const graphPagerank = async (
    colOrPath: string | CollectionReference,
    seeds: string[] | null,
    opts?: { direction?: TraverseDirection; edge?: string; via?: string; nodeMatch?: PropMatch; damping?: number; top?: number }
): Promise<any> => {
    const collection = typeof colOrPath === 'string' ? colOrPath : colOrPath.path;
    const res = await exec({
        op: 'graph_pagerank',
        collection,
        ...(seeds?.length ? { seeds } : {}),
        direction: opts?.direction ?? 'outgoing',
        ...(opts?.edge ? { edge: opts.edge } : {}),
        ...(opts?.via ? { via: opts.via } : {}),
        ...(opts?.nodeMatch ? { node_match: opts.nodeMatch } : {}),
        ...(opts?.damping ? { damping: opts.damping } : {}),
        ...(opts?.top ? { top: opts.top } : {})
    });
    return res.value_result.value;
};

/** Seed-scoped N-hop subgraph: export-graph node/edge shape scoped to one
 * seed. maxDepth = hop cap (default 10). Missing seed = empty graph. */
export const subgraph = async (
    colOrPath: string | CollectionReference,
    seedId: string,
    opts?: { maxDepth?: number; direction?: TraverseDirection; edge?: string; via?: string; nodeMatch?: PropMatch }
): Promise<any> => {
    const collection = typeof colOrPath === 'string' ? colOrPath : colOrPath.path;
    const res = await exec({
        op: 'subgraph',
        collection,
        seed_id: seedId,
        max_depth: opts?.maxDepth ?? 10,
        direction: opts?.direction ?? 'outgoing',
        ...(opts?.edge ? { edge: opts.edge } : {}),
        ...(opts?.via ? { via: opts.via } : {}),
        ...(opts?.nodeMatch ? { node_match: opts.nodeMatch } : {})
    });
    return res.value_result.value;
};

/** Hybrid retrieval: FTS (sparse) + KNN (dense) fused with RRF. Rows
 * [{id, score (fused, desc), doc}]. rrfK 0 = engine default 60. */
export const hybridSearch = async (
    colOrPath: string | CollectionReference,
    textField: string,
    textQuery: string,
    vecField: string,
    query: number[] | Float32Array,
    k = 10,
    rrfK = 0
): Promise<Array<{ id: string; score: number; doc: DocumentSnapshot }>> => {
    const collection = typeof colOrPath === 'string' ? colOrPath : colOrPath.path;
    const res = await exec({
        op: 'hybrid_search',
        collection,
        text_field: textField,
        text_query: textQuery,
        vec_field: vecField,
        query: Array.from(query),
        k,
        rrf_k: rrfK
    });
    return (res.hybrid_result.hits as any[]).map((h) => ({
        id: h.id as string,
        score: h.score as number,
        doc: new DocumentSnapshot(h.id as string, true, h.doc)
    }));
};

/** Point read with its storage version (optimistic concurrency:
 * compare `version` before patching; mismatch = someone wrote first). */
export const getVersioned = async (
    colOrPath: string | CollectionReference,
    docId: string
): Promise<{ data: HakoRecord; version: number } | null> => {
    const collection = typeof colOrPath === 'string' ? colOrPath : colOrPath.path;
    const res = await exec({ op: 'get_versioned', collection, doc_id: docId });
    const dv = res.document_version;
    return dv?.data ? { data: dv.data, version: dv.version } : null;
};

/** Resolve a `{"__ref__": "col/id"}` reference field to its doc. */
export const getByRef = async (
    collectionPath: string,
    docId: string
): Promise<DocumentSnapshot | null> => {
    const res = await exec({ op: 'get_by_ref', reference: { __ref__: `${collectionPath}/${docId}` } });
    const data = res.document?.data;
    return data ? new DocumentSnapshot(docId, true, data) : null;
};

/** Write one doc under a parent doc's subcollection namespace. Returns
 * the storage key path used. */
export const putSubdocument = async (
    collectionPath: string,
    docId: string,
    subcollection: string,
    subdocId: string,
    data: HakoRecord
): Promise<string> => {
    const res = await exec({
        op: 'put_subdocument',
        collection: collectionPath,
        doc_id: docId,
        subcollection,
        subdoc_id: subdocId,
        data: normalizeValue(data)
    });
    return res.value_result.value as string;
};

/** Plan-only query explanation: scan type, chosen index, why filters are
 * (not) index-satisfied. Nothing executes. */
export const explainQuery = async (
    q: Query | CollectionReference | CollectionGroupReference
): Promise<any> => {
    const res = await exec({ op: 'query', action: 'explain', ...buildQueryParams(q) });
    return res.value_result.value;
};

/** Storage-prefix rename of a whole collection (fast, atomic). */
export const renameCollection = async (from: string, to: string) =>
    exec({ op: 'rename_collection', from, to });

/** Hard-drop a collection: tombstones live docs, unlinks the shard dir. */
export const dropCollection = async (collection: string): Promise<DropResult> => {
    const res = await exec({ op: 'drop_collection', collection });
    return res.drop_result;
};

/** Un-withhold from replication: docId scopes to one key, otherwise the
 * whole collection's local-only marks clear. */
export const replicate = async (collection: string, docId?: string) =>
    exec({ op: 'replicate', collection, ...(docId ? { doc_id: docId } : {}) });

/** What background work is outstanding (index recovery, backfills,
 * pending blob bytes). Poll before cursor paging / replica handoff. */
export const quiescenceStatus = async (): Promise<QuiescenceStatus> => {
    const res = await exec({ op: 'quiescence' });
    return res.value_result.value;
};

/** Pin/unpin a collection to this instance only (never replicates). */
export const setCollectionLocal = async (collection: string, local: boolean) =>
    exec({ op: 'set_collection_local', collection, local });

/** Whole-engine read-only toggle (rejects writes, serves reads). */
export const setReadOnly = async (enabled: boolean) =>
    exec({ op: 'set_read_only', enabled });