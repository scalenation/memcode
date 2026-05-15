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