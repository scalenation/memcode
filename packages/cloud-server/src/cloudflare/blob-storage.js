const encoder = new TextEncoder();

export function defaultSyncBlobKey(workspaceId, cursor, blobId) {
  return `blobs/${workspaceId}/${cursor}-${blobId}.bin`;
}

export async function storeSyncPayload(env, input) {
  const payloadSize = encoder.encode(input.payload).byteLength;
  const useR2 = (env.SYNC_PAYLOAD_STORAGE ?? 'r2') === 'r2' && env.SYNC_BLOBS;

  if (!useR2) {
    return {
      payloadEncrypted: input.payload,
      payloadStorageKey: null,
      payloadSize,
    };
  }

  const key = defaultSyncBlobKey(input.workspaceId, input.cursor, input.blobId);
  await env.SYNC_BLOBS.put(key, input.payload, {
    httpMetadata: { contentType: 'text/plain; charset=utf-8' },
  });

  return {
    payloadEncrypted: null,
    payloadStorageKey: key,
    payloadSize,
  };
}

export async function loadSyncPayload(env, record) {
  if (typeof record.payload_encrypted === 'string' && record.payload_encrypted.length > 0) {
    return record.payload_encrypted;
  }

  if (record.payload_storage_key && env.SYNC_BLOBS) {
    const object = await env.SYNC_BLOBS.get(record.payload_storage_key);
    if (!object) return null;
    return object.text();
  }

  return null;
}

export async function deleteWorkspacePayloads(env, db, workspaceId) {
  const rows = await db.all(
    'SELECT payload_storage_key FROM sync_blobs WHERE workspace_id = ? AND payload_storage_key IS NOT NULL',
    [workspaceId],
  );

  if (!env.SYNC_BLOBS) return;

  for (const row of rows.rows) {
    if (row.payload_storage_key) {
      await env.SYNC_BLOBS.delete(row.payload_storage_key);
    }
  }
}