// Cloud sync client. Pairs with hakotauri::cloud_sync — invoke this
// module instead of driving sync commands hand-rolled per app.
import { invoke } from '@tauri-apps/api/core';
import { listen, type UnlistenFn } from '@tauri-apps/api/event';

export type CloudSyncMode = 'server' | 'client';

export interface CloudSyncConfig {
    enabled: boolean;
    mode: CloudSyncMode;
    serverUrl?: string;
    bindAddr?: string;
    roomName?: string;
    roomKey?: string;
    authToken: string;
    /** Group API key for `registered` groups. Stored device-local. */
    apiKey?: string;
}

export interface CloudStatus {
    mode: CloudSyncMode;
    connected: boolean;
    room_name: string;
    room_key: string;
    active_clients: number;
    queued_writes: number;
    hosted_rooms: number;
}

export interface CloudPeer {
    peer_key: string;
    prefix: string;
}

export interface GroupPolicy {
    roomName: string;
    mode: string;
    hasKey: boolean;
    members: string[];
}

/**
 * Start/stop cloud sync. selfId is yours to supply (the old tokocepat code
 * read it from the license HWID — the SDK never touches app identity).
 * Returns "ON" or "OFF".
 */
export const toggleCloudSync = async (
    enabled: boolean,
    selfId: string,
    options: {
        mode: CloudSyncMode;
        serverUrl?: string;
        bindAddr?: string;
        roomName?: string;
        roomKey?: string;
        authToken?: string;
        apiKey?: string;
    }
): Promise<string> => {
    return invoke<string>('toggle_cloud_sync', {
        enabled,
        mode: options.mode,
        server_url: options.serverUrl,
        bind_addr: options.bindAddr,
        room_name: options.roomName,
        room_key: options.roomKey,
        auth_token: options.authToken ?? '',
        api_key: options.apiKey,
        self_id: selfId
    });
};

export const getCloudSyncStatus = async (): Promise<CloudStatus | null> => {
    return invoke<CloudStatus | null>('get_cloud_sync_status');
};

/** Connected peers (server: all room members; client: the uplink if tracked). */
export const getCloudPeers = async (): Promise<CloudPeer[]> => {
    return invoke<CloudPeer[]>('get_cloud_peers');
};

/** Saved prefs for prefilling the settings UI (secrets included). */
export const getCloudConfig = async (): Promise<CloudSyncConfig | null> => {
    return invoke<CloudSyncConfig | null>('get_cloud_config');
};

/** Re-enable cloud sync on startup if it was previously enabled. */
export const bootstrapCloudSync = async (selfId: string): Promise<void> => {
    return invoke<void>('bootstrap_cloud_sync', { self_id: selfId });
};

// --- Group security (server-side `__groups` policy) ---

export const cloudGroupGet = async (roomName: string): Promise<GroupPolicy> => {
    return invoke<GroupPolicy>('cloud_group_get', { room_name: roomName });
};

/** Fresh 256-bit API key (64 hex). Only the hash is persisted — store this. */
export const cloudGroupNewKey = async (): Promise<string> => {
    return invoke<string>('cloud_group_new_key');
};

export const cloudGroupSet = async (
    roomName: string,
    mode: 'open' | 'registered',
    options?: { apiKey?: string; members?: string[] }
): Promise<GroupPolicy> => {
    return invoke<GroupPolicy>('cloud_group_set', {
        room_name: roomName,
        mode,
        api_key: options?.apiKey,
        members: options?.members
    });
};

export const cloudGroupAddMember = async (roomName: string, clientId: string): Promise<GroupPolicy> => {
    return invoke<GroupPolicy>('cloud_group_add_member', { room_name: roomName, client_id: clientId });
};

export const cloudGroupRemoveMember = async (roomName: string, clientId: string): Promise<GroupPolicy> => {
    return invoke<GroupPolicy>('cloud_group_remove_member', { room_name: roomName, client_id: clientId });
};

/** Subscribe to "cloud_sync_on" / "cloud_sync_off" events. */
export const onCloudSyncStateChange = async (
    onEnabled: (enabled: boolean) => void
): Promise<UnlistenFn> => {
    const off1 = await listen('cloud_sync_on', () => onEnabled(true));
    const off2 = await listen('cloud_sync_off', () => onEnabled(false));
    return () => { off1(); off2(); };
};
