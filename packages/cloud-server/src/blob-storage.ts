import { Buffer } from 'node:buffer';
import { config } from './config';

export type SyncBlobRecord = {
  id: string;
  workspace_id: string;
  cursor: string;
  payload_encrypted: string | null;
  payload_storage_key?: string | null;
  payload_size?: number | string | null;
};

export type StoredSyncPayload = {
  payloadEncrypted: string | null;
  payloadStorageKey: string | null;
  payloadSize: number;
};

interface StorePayloadInput {
  blobId: string;
  workspaceId: string;
  cursor: string;
  payload: string;
}

interface SyncBlobStorage {
  storePayload(input: StorePayloadInput): Promise<StoredSyncPayload>;
  loadPayload(record: SyncBlobRecord): Promise<string | null>;
  deleteWorkspacePayloads(workspaceId: string): Promise<void>;
}

class DatabaseSyncBlobStorage implements SyncBlobStorage {
  async storePayload(input: StorePayloadInput): Promise<StoredSyncPayload> {
    return {
      payloadEncrypted: input.payload,
      payloadStorageKey: null,
      payloadSize: Buffer.byteLength(input.payload, 'utf8'),
    };
  }

  async loadPayload(record: SyncBlobRecord): Promise<string | null> {
    return record.payload_encrypted ?? null;
  }

  async deleteWorkspacePayloads(_workspaceId: string): Promise<void> {
    // Database-backed storage is deleted with the owning sync_blobs rows.
  }
}

function buildSyncBlobStorage(): SyncBlobStorage {
  switch (config.syncPayloadStorage) {
    case 'database':
      return new DatabaseSyncBlobStorage();
    default:
      throw new Error(`Unsupported SYNC_PAYLOAD_STORAGE mode: ${config.syncPayloadStorage}`);
  }
}

export const syncBlobStorage = buildSyncBlobStorage();