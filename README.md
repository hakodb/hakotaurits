# hakotaurits

> Part of [**HakoDB**](https://github.com/hakodb/hakodb) — embedded Firestore-style document DB in Rust. The engine + C ABI live in `hakodb/hakodb`; this repo holds the Tauri TypeScript client (pairs with the [`hakotauri`](https://github.com/hakodb/hakotauri) Rust gateway crate).

TypeScript client for Tauri apps backed by the
[`hakotauri`](https://github.com/hakodb/hakotauri) Rust gateway crate: Firestore-shaped
API over Tauri IPC (`invoke`), binary MessagePack payloads, and
`onSnapshot` live listeners.

## Compatibility

| @hakodb/tauri | hakotauri (Rust) | hakodb core |
|---|---|---|
| 0.2.0 | 0.2.0 | `hakodb 0.8.23+` (crates.io) |
| 0.3.1 | 0.4.x | `hakodb 0.11.0+` (relocate/load/unload/unloaded ops; no gateway change since, works with 0.4.2/0.12.2) |
| 0.3.2 | 0.4.4 | `hakodb 0.13+` (`createVectorIndex` + `findNear` vector ops) |
| 0.3.3 | 0.4.5 | `hakodb 0.13+` (`flushDatabase` + `listStorageKeys` consumer ops) |
| 0.3.4 | 0.4.8 | `hakodb 0.14+` (`createTraverseIndex` + `findPaths` graph BFS) |
| 0.3.5 | 0.4.9 | `hakodb 0.15+` (Phase B: `createEdgeIndex` + weighted `findPaths`) |
| 0.3.6 | 0.4.11 | `hakodb 0.17.1` (tombstone version fix + engine JSON read paths ride along inside the gateway; no new ops) |
| 0.3.7 | 0.5.0 | `hakodb 0.19.0` (`getMinFromServer` / `getMaxFromServer` with `null` for an empty numeric set; `docExists` + `compactCollection`) |
| 0.3.8 | 0.6.3 | `hakodb 0.19.4+` (full parity: `execTransaction`, `runPipeline`, `dropIndex`, `findNearBatch` + hybrid/maxDistance `findNear`, `findSimplePaths`, `graphAnalysis`, `exportGraph`, `getVersioned`, `getByRef`, `putSubdocument`, `explainQuery`, `renameCollection`, `dropCollection`, `replicate`, `quiescenceStatus`, `setCollectionLocal`, `setReadOnly`; HNSW `m`/`ef` knobs + `inner_product` metric) |
| 0.3.9 | 0.6.3 | `hakodb 0.20.0+` (soft-delete suite surfaced: `restoreDoc`, `restoreAvailable`, `deleteQueue`; `force` hard delete on `deleteDoc` + batch delete mutators) |
| 0.3.11 | 0.6.3 | full op parity (last three gateway ops: `sweepNow`, `compact`, `backup`) |

The op enum in `src/tauri.ts` must match `HakoOp` in the
`hakotauri` crate — bump both together.

## Check

```sh
npm install
npx tsc --noEmit
```

## API guidance: query and write paths

Consumers should not have to guess which execution or write entry point to use. The core exposes one canonical executor plus advisory-deprecated wrappers and several materialization lanes with different costs.

### Execution lanes

| Lane | Returns | Use when |
|---|---|---|
| canonical executor (`hk_query_execute_ex` / SDK default) | JSON documents for an application | ordinary API calls |
| JSON egress (`hk_query_execute_json`) | JSON from pinned bytes, no owned document | wire/egress output |
| handles (`hk_query_execute_to_handles`) | borrowed document handles | engine throughput, caller reads selected fields |
| raw (`hk_query_execute_raw`) | pinned storage bytes | index-satisfied scans, zero decode |
| aggregation / explain | aggregate values or plan report | tuning and aggregate-only queries |

Do not compare a JSON-document lane with an engine-only lane and call it the same benchmark. Mark lanes without an equivalent in another engine as not applicable.

### In this repository

- command-to-API mapping and return shapes
- when results are JSON vs typed rows
- write/batch commands and index readiness

### Further reading

- Core decision table: https://github.com/hakodb/hakodb/blob/main/docs/ffi-query-lanes.md
- Manual C ABI chapter: https://hakodb.github.io/manual/sdk-c-abi.html
