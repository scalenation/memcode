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
    // neon() accepts a plain string at runtime despite the TemplateStringsArray typing
    const rawSql = sql as unknown as (t: string, ...p: unknown[]) => Promise<unknown[]>;
    const rows = (await rawSql(text, ...(params ?? []))) as T[];
    return { rows, rowCount: rows.length };
  },
};
