import pg from 'pg';
import dotenv from 'dotenv';
import path from 'path';

dotenv.config({ path: path.resolve(__dirname, '../.env') });

const connectionString = process.env.DATABASE_URL;
console.log("Checking database:", connectionString);

const pool = new pg.Pool({
    connectionString,
    ssl: { rejectUnauthorized: false }
});

async function main() {
    const client = await pool.connect();
    try {
        const res = await client.query(`
            SELECT table_name 
            FROM information_schema.tables 
            WHERE table_schema = 'public'
            ORDER BY table_name;
        `);
        console.log("Tables in database:", res.rows.map(r => r.table_name));
    } catch (e) {
        console.error("Error checking tables:", e);
    } finally {
        client.release();
        await pool.end();
    }
}

main();
