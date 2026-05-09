import { Pool, neonConfig } from '@neondatabase/serverless';
import ws from 'ws';
import { config } from '../config';

// Required for @neondatabase/serverless Pool in Node.js (non-edge) environments
neonConfig.webSocketConstructor = ws;

export const pool = new Pool({ connectionString: config.databaseUrl });
