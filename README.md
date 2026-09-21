# hakotaurits

TypeScript client for Tauri apps backed by the
[`hakotauri`](../hakotauri) Rust gateway crate: Firestore-shaped
API over Tauri IPC (`invoke`), binary MessagePack payloads, and
`onSnapshot` live listeners.

## Compatibility

| @hakodb/tauri | hakotauri (Rust) | hakodb core |
|---|---|---|
| 0.1.1 | 0.1.1 | `cloud_sync` branch / `v0.8.21`+ release asset |

The op enum in `src/tauri.ts` must match `HakoOp` in the
`hakotauri` crate — bump both together.

## Check

```sh
npm install
npx tsc --noEmit
```
