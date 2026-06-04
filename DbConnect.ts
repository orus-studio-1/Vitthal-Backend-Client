import 'dotenv/config';
import { Pool } from 'pg';

const connectionString = process.env.DATABASE_URL;

if (!connectionString || !connectionString.startsWith('postgresql://')) {
  throw new Error('DATABASE_URL is missing or invalid. It must start with postgresql://');
}

const isLocal = connectionString.includes('localhost') || connectionString.includes('127.0.0.1');

const pool = new Pool({
  connectionString,
  max: 5,                        // Neon free tier has limited connections — keep small
  idleTimeoutMillis: 10000,      // Release idle connections after 10s (Neon drops them anyway)
  connectionTimeoutMillis: 10000, // Wait up to 10s for a connection (cold starts are slow)
  ssl: isLocal ? false : { rejectUnauthorized: false }, // Required for Neon serverless
  // TCP keepalive to detect dead sockets before they timeout
  keepAlive: true,
  keepAliveInitialDelayMillis: 10000,
});

// Catch pool errors so idle connection drops don't crash the server
pool.on('error', (err) => {
  console.error('Unexpected error on idle database client:', err);
});

export default pool;
