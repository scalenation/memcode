import { Pool, neonConfig } from '@neondatabase/serverless';
import { config } from '../config';

// Use HTTP fetch instead of WebSocket — no cold-start TCP overhead in serverless
neonConfig.poolQueryViaFetch = true;

export const pool = new Pool({ connectionString: config.databaseUrl });
