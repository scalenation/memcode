import 'dotenv/config';
import { pool } from '../db/client';

const DEFAULT_BATCH_SIZE = 500;

async function backfillSyncPayloadSize(): Promise<void> {
  const batchSizeArg = parseInt(process.argv[2] ?? '', 10);
  const batchSize = Number.isInteger(batchSizeArg) && batchSizeArg > 0
    ? batchSizeArg
    : DEFAULT_BATCH_SIZE;

  console.log(`Backfilling sync_blobs.payload_size in batches of ${batchSize}...`);

  let totalUpdated = 0;
  while (true) {
    const result = await pool.query<{ id: string }>(
      `WITH batch AS (
         SELECT id
         FROM sync_blobs
         WHERE payload_size IS NULL AND payload_encrypted IS NOT NULL
         ORDER BY created_at ASC
         LIMIT $1
       )
       UPDATE sync_blobs AS blobs
       SET payload_size = OCTET_LENGTH(blobs.payload_encrypted)
       FROM batch
       WHERE blobs.id = batch.id
       RETURNING blobs.id`,
      [batchSize],
    );

    const updated = result.rowCount;
    totalUpdated += updated;
    console.log(`Updated ${updated} rows in this batch (${totalUpdated} total).`);

    if (updated < batchSize) break;
  }

  console.log(`Backfill complete. Updated ${totalUpdated} rows.`);
}

backfillSyncPayloadSize().catch((error) => {
  console.error('Backfill failed:', error);
  process.exit(1);
});