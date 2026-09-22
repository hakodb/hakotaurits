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

The op enum in `src/tauri.ts` must match `HakoOp` in the
`hakotauri` crate — bump both together.

## Check

```sh
npm install
npx tsc --noEmit
```
