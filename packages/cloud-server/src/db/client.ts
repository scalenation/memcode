import { neon } from '@neondatabase/serverless';
import { config } from '../config';

// Pure HTTP-based driver — no WebSocket, no TCP, zero connection overhead
const sql = neon(config.databaseUrl);

// pg-compatible shim: pool.query(text, params?) -> { rows, rowCount }
export const pool = {
  query: async <T extends Record<string, unknown> = Record<string, unknown>>(
    text: string,
    params?: unknown[],
  ): Promise<{ rows: T[]; rowCount: number }> => {
    // Use sql.query() which accepts plain strings with $1/$2 params
    const rows = (await sql.query(text, params ?? [])) as T[];
    return { rows, rowCount: rows.length };
  },
};
