const fs = require('fs');
const path = require('path');
const { Pool } = require('pg');
const dotenv = require('dotenv');

// Load environment variables
const envPath = path.join(__dirname, '../.env');
dotenv.config({ path: envPath });

const connectionString = process.env.DATABASE_URL;
if (!connectionString) {
    console.error("DATABASE_URL is not defined in the .env file.");
    process.exit(1);
}

const pool = new Pool({ connectionString });

async function run() {
    const sqlPath = path.join(__dirname, '../migrations/2026-06-08_dynamic_attributes.sql');
    const sql = fs.readFileSync(sqlPath, 'utf8');

    console.log("Connecting to the database...");
    const client = await pool.connect();
    try {
        console.log("Executing migration SQL...");
        await client.query("BEGIN");
        await client.query(sql);
        await client.query("COMMIT");
        console.log("Migration executed successfully!");
    } catch (err) {
        await client.query("ROLLBACK");
        console.error("Migration failed:", err);
        process.exit(1);
    } finally {
        client.release();
        await pool.end();
    }
}

run();
