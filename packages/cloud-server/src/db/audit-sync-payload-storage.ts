import 'dotenv/config';
import { pool } from '../db/client';

type SummaryRow = {
  total_blobs: string;
  blobs_missing_payload_size: string;
  blobs_with_storage_key: string;
  total_payload_size: string | null;
};

type LargestBlobRow = {
  id: string;
  workspace_id: string;
  cursor: string;
  payload_size: string | null;
  payload_storage_key: string | null;
  created_at: string;
};

async function auditSyncPayloadStorage(): Promise<void> {
  const summaryResult = await pool.query<SummaryRow>(
    `SELECT
       COUNT(*)::bigint AS total_blobs,
       COUNT(*) FILTER (WHERE payload_size IS NULL AND payload_encrypted IS NOT NULL)::bigint AS blobs_missing_payload_size,
       COUNT(*) FILTER (WHERE payload_storage_key IS NOT NULL)::bigint AS blobs_with_storage_key,
       COALESCE(SUM(COALESCE(payload_size, OCTET_LENGTH(payload_encrypted))), 0)::bigint AS total_payload_size
     FROM sync_blobs`,
  );

  const largestBlobsResult = await pool.query<LargestBlobRow>(
    `SELECT id, workspace_id, cursor, payload_size, payload_storage_key, created_at
     FROM sync_blobs
     ORDER BY COALESCE(payload_size, OCTET_LENGTH(payload_encrypted)) DESC, created_at DESC
     LIMIT 10`,
  );

  const summary = summaryResult.rows[0];
  const output = {
    summary: {
      totalBlobs: parseInt(summary.total_blobs, 10),
      blobsMissingPayloadSize: parseInt(summary.blobs_missing_payload_size, 10),
      blobsWithStorageKey: parseInt(summary.blobs_with_storage_key, 10),
      totalPayloadSize: parseInt(summary.total_payload_size ?? '0', 10),
    },
    largestBlobs: largestBlobsResult.rows.map((row) => ({
      id: row.id,
      workspaceId: row.workspace_id,
      cursor: row.cursor,
      payloadSize: parseInt(row.payload_size ?? '0', 10),
      payloadStorageKey: row.payload_storage_key,
      createdAt: row.created_at,
    })),
  };

  console.log(JSON.stringify(output, null, 2));
}

auditSyncPayloadStorage().catch((error) => {
  console.error('Audit failed:', error);
  process.exit(1);
});