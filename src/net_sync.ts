// Mesh (LAN) sync client. Pairs with hakotauri::net_sync — invoke this
// module instead of driving sync commands hand-rolled per app.
import { invoke } from '@tauri-apps/api/core';
import { listen, type UnlistenFn } from '@tauri-apps/api/event';

export interface NetworkStatus {
    status: 'idle' | 'connected' | 'syncing';
    self_id: string;
    peer_count: number;
    known_peers: string[];
}

export interface NetworkPeer {
    id: string;
    is_online: boolean;
    status: string;
    name: string;
}

export interface ToggleNetSyncOptions {
    /** Explicit room key. Omit to reuse the saved app_state/sync_group key. */
    roomKey?: string;
    /** Omit for the SDK default (["app_state"]). */
    excluded?: string[];
    /** Default sync port when bootstrapping. */
    port?: number;
}

/**
 * Start/stop mesh sync. selfId is yours to supply (the old tokocepat code
 * read it from the license HWID — the SDK never touches app identity).
 * Returns "ON" or "OFF".
 */
export const toggleNetSync = async (
    enabled: boolean,
    port: number,
    selfId: string,
    options?: ToggleNetSyncOptions
): Promise<string> => {
    return invoke<string>('toggle_net_sync', {
        enabled,
        port,
        self_id: selfId,
        room_key: options?.roomKey,
        excluded: options?.excluded
    });
};

export const getSyncStatus = async (): Promise<NetworkStatus | null> => {
    return invoke<NetworkStatus | null>('get_sync_status');
};

export const checkSyncSecurityExists = async (collection: string): Promise<boolean> => {
    return invoke<boolean>('check_sync_security_exists', { collection });
};

/** Live peers joined with the security roster (unknown ids → "new_device"). */
export const listNetworkPeers = async (securityCollection: string): Promise<NetworkPeer[]> => {
    return invoke<NetworkPeer[]>('list_network_peers', { security_collection: securityCollection });
};

/**
 * Restore half of a local reset: vacuum tombstones + clear local-only marks
 * per collection, so the next handshake pulls peer state. Call BEFORE
 * toggleNetSync(true) when re-enabling sync after a reset. Returns
 * ["collection:purged", ...].
 */
export const prepareSyncRestore = async (collections: string[]): Promise<string[]> => {
    return invoke<string[]>('prepare_sync_restore', { collections });
};

/** Re-enable mesh sync on startup if it was previously enabled. */
export const bootstrapSync = async (
    selfId: string,
    options?: ToggleNetSyncOptions
): Promise<void> => {
    return invoke<void>('bootstrap_sync', {
        port: options?.port ?? 8055,
        self_id: selfId,
        excluded: options?.excluded
    });
};

/** Subscribe to "sync_on" / "sync_off" events emitted by the toggle. */
export const onSyncStateChange = async (
    onEnabled: (enabled: boolean) => void
): Promise<UnlistenFn> => {
    const off1 = await listen('sync_on', () => onEnabled(true));
    const off2 = await listen('sync_off', () => onEnabled(false));
    return () => { off1(); off2(); };
};
