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

The op enum in `src/tauri.ts` must match `HakoOp` in the
`hakotauri` crate — bump both together.

## Check

```sh
npm install
npx tsc --noEmit
```
