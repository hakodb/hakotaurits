# firelite-tauri-ts

TypeScript client for Tauri apps backed by the
[`hako-tauri`](../firelite-tauri) Rust gateway crate: Firestore-shaped
API over Tauri IPC (`invoke`), binary MessagePack payloads, and
`onSnapshot` live listeners.

## Compatibility

| @hakodb/tauri | hako-tauri (Rust) | hakodb core |
|---|---|---|
| 0.1.1 | 0.1.1 | `cloud_sync` branch / `v0.8.20`+ release asset |

The op enum in `src/tauri.ts` must match `HakoOp` in the
`hako-tauri` crate — bump both together.

## Check

```sh
npm install
npx tsc --noEmit
```
