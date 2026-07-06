import fs from 'fs';
import path from 'path';
import pg from 'pg';

const envPath = path.resolve(__dirname, '../.env');
console.log("Reading environment from:", envPath);
let databaseUrl = '';
if (fs.existsSync(envPath)) {
    const envLines = fs.readFileSync(envPath, 'utf8').split('\n');
    for (const line of envLines) {
        if (line.trim().startsWith('DATABASE_URL=')) {
            databaseUrl = line.split('DATABASE_URL=')[1].replace(/"/g, '').trim();
            break;
        }
    }
}

if (!databaseUrl) {
    console.error("Could not find DATABASE_URL in .env");
    process.exit(1);
}

const pool = new pg.Pool({ connectionString: databaseUrl });

async function main() {
    const migrationPath = path.resolve(__dirname, '../migrations/2026-07-06_verification_keys.sql');
    console.log("Reading migration file from:", migrationPath);
    
    if (!fs.existsSync(migrationPath)) {
        console.error("Migration file does not exist at:", migrationPath);
        process.exit(1);
    }
    
    const sql = fs.readFileSync(migrationPath, 'utf8');
    
    const client = await pool.connect();
    try {
        console.log("Running migration SQL against database...");
        await client.query('BEGIN');
        await client.query(sql);
        await client.query('COMMIT');
        console.log("Migration executed successfully! 🎉");
    } catch (error) {
        await client.query('ROLLBACK');
        console.error("Error executing migration:", error);
    } finally {
        client.release();
        await pool.end();
    }
}

main();
